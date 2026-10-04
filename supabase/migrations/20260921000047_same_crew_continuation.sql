-- KAN-50: "Same crew, new plan" reaches the crew.
--
-- Each challenge is its own group (KAN-29), so a new plan with the same people is a new
-- group the others have to join. Until now they could only hear about it out of band.
-- The new group now records the finished group it continues, and every member of that
-- finished group who has not joined yet can see the invitation and accept it by id,
-- without the invite code ever leaving the server.
--
-- Placement stays a choice, not automatic: it would collide with one challenge at a time
-- and count people toward the unlock who never chose to continue.

alter table groups
  add column continues_group_id uuid references groups(id) on delete set null;

comment on column groups.continues_group_id is
  'The finished group this one continues ("same crew, new plan"). Its members may join '
  'this group by id. Validated by create-group: the creator was a member and it had ended.';

-- Pending invitations for the caller: groups that continue one the caller was in, which
-- the caller has not joined and which are still forming or active. Newest first, so
-- several successors started by different members all show. SECURITY DEFINER because the
-- caller cannot read a group they are not in; keyed on auth.uid() with no arguments, and
-- it returns no invite token -- accepting goes through join-group by id.
create or replace function public.my_continuations()
returns table (
  group_id uuid,
  name text,
  continues_group_id uuid,
  plan_title text,
  plan_image_path text,
  day_count int,
  member_count int,
  created_by uuid,
  created_by_name text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    n.id,
    n.name,
    n.continues_group_id,
    pc.title,
    pc.image_path,
    pc.day_count,
    (select count(*) from group_members m where m.group_id = n.id)::int,
    n.created_by,
    u.name,
    n.created_at
  from groups n
  join group_members prev
    on prev.group_id = n.continues_group_id and prev.user_id = auth.uid()
  join plan_challenges pc on pc.id = n.plan_challenge_id
  left join users u on u.id = n.created_by
  where n.challenge_status in ('forming', 'active')
    and not exists (
      select 1 from group_members me where me.group_id = n.id and me.user_id = auth.uid()
    )
  order by n.created_at desc
$$;

revoke all on function public.my_continuations() from public, anon, authenticated;
grant execute on function public.my_continuations() to authenticated;
