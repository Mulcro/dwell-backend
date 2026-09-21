-- Access helpers + row-level security. Deny-by-default on every table.
--
-- Every helper is SECURITY DEFINER so the lookup inside runs with RLS off. That is what
-- stops a policy on group_members that queries group_members from recursing infinitely.

create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$;

create or replace function public.shares_group_with(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from group_members mine
    join group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = auth.uid() and theirs.user_id = p_user_id
  );
$$;

-- PHASE1 #1/#2: the single definition of "can this caller see this reflection".
-- Own reflection is always visible. Someone else's is visible only when it is APPROVED
-- and the caller has their own APPROVED reflection for the same day. The design doc's
-- policy checked neither moderation_status, which leaked group-mates' pending and
-- flagged posts. comments and reactions reuse this instead of a bare membership check.
create or replace function public.is_reflection_unlocked(p_reflection_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from reflections r
    join day_instances di on di.id = r.day_instance_id
    join group_members gm on gm.group_id = di.group_id and gm.user_id = auth.uid()
    where r.id = p_reflection_id
      and (
        r.user_id = auth.uid()
        or (
          r.moderation_status = 'approved'
          and exists (
            select 1 from reflections mine
            where mine.day_instance_id = r.day_instance_id
              and mine.user_id = auth.uid()
              and mine.moderation_status = 'approved'
          )
        )
      )
  );
$$;

alter table users enable row level security;
alter table plan_challenges enable row level security;
alter table plan_days enable row level security;
alter table groups enable row level security;
alter table group_members enable row level security;
alter table day_instances enable row level security;
alter table reflections enable row level security;
alter table comments enable row level security;
alter table reactions enable row level security;
alter table ai_insights enable row level security;
alter table leaderboard_entries enable row level security;

-- users: own profile (read + update), plus group-mates' rows for member-list display names.
create policy "read own or group-mate profile" on users
  for select using (id = auth.uid() or public.shares_group_with(id));

create policy "update own profile" on users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- Plan catalogue is public reference data to any signed-in user.
create policy "read plans" on plan_challenges for select to authenticated using (true);
create policy "read plan days" on plan_days for select to authenticated using (true);

-- Group-scoped reads all express membership through is_group_member.
create policy "read my groups" on groups
  for select using (public.is_group_member(id));

create policy "read members of my groups" on group_members
  for select using (public.is_group_member(group_id));

create policy "read days of my groups" on day_instances
  for select using (public.is_group_member(group_id));

create policy "read leaderboard of my groups" on leaderboard_entries
  for select using (public.is_group_member(group_id));

-- ai_insights: group-wide insights to any member; a personal nudge only to its target.
create policy "read insights of my groups" on ai_insights
  for select using (
    public.is_group_member(group_id)
    and (target_user_id is null or target_user_id = auth.uid())
  );

-- reflections: read-only for clients, gated by the unlock rule above.
-- No INSERT policy, and INSERT is revoked outright, so every write goes through
-- /submit-reflection under the service role and moderation can never be bypassed.
-- No UPDATE policy either: a client must never flip its own moderation_status.
create policy "read unlocked reflections" on reflections
  for select using (public.is_reflection_unlocked(id));

revoke insert, update, delete on reflections from authenticated;

-- comments: readable once the target reflection is unlocked for the caller; insert
-- requires the same, so you cannot comment on a reflection you have not earned.
-- MVP deliberately skips comment moderation (see design doc 1.1).
create policy "read comments on unlocked reflections" on comments
  for select using (public.is_reflection_unlocked(reflection_id));

create policy "insert own comment" on comments
  for insert with check (
    user_id = auth.uid() and public.is_reflection_unlocked(reflection_id)
  );

-- reactions: same unlock rule; one row per (reflection, user, emoji).
create policy "read reactions on unlocked reflections" on reactions
  for select using (public.is_reflection_unlocked(reflection_id));

create policy "insert own reaction" on reactions
  for insert with check (
    user_id = auth.uid() and public.is_reflection_unlocked(reflection_id)
  );

create policy "delete own reaction" on reactions
  for delete using (user_id = auth.uid());
