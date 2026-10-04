-- KAN-42: a challenge completes the moment everyone has posted on its final day.
--
-- Until now the only way out was open_ready_next_days(): final day threshold_met AND open
-- for 24 hours. So a group that all finished Day N sat 'active' for up to a day with
-- nothing left to do, and the app looked as if there were more. The rule is now either:
--   (a) the final day is threshold_met and its 24h window has elapsed -> completed by the
--       sweep, exactly as before; or
--   (b) every member who was in the group when the final day opened has an approved
--       reflection on it -> completed here, now.
-- Completion here does what the sweep does -- flip the group, complete the day, dispatch
-- the summary -- and the two cannot both fire: the sweep only takes threshold_met days,
-- and this path only flips an active group once, under its row lock, so a pause or end
-- that lands meanwhile is never overwritten. The summary function is guarded by a unique
-- index besides.
--
-- "Everyone" is everyone still in the group who had joined before the final day opened.
-- Someone who has since left or deleted their account can neither post nor hold the
-- group open, which is the same rule the threshold math applies.

create or replace function public.check_day_threshold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_opened_at timestamptz;
  v_day_index int;
  v_pct int;
  v_member_count int;
  v_posted_count int;
  v_flipped int;
  v_day_count int;
  v_challenge_status text;
  v_members_posted int;
  v_closed int;
begin
  select group_id, opened_at, day_index into v_group_id, v_opened_at, v_day_index
    from day_instances where id = new.day_instance_id;

  select g.catch_up_threshold_pct, g.challenge_status::text, pc.day_count
    into v_pct, v_challenge_status, v_day_count
    from groups g join plan_challenges pc on pc.id = g.plan_challenge_id
   where g.id = v_group_id;

  -- Members who had joined before this day opened; a late joiner never changes a past day's math.
  select count(*) into v_member_count from group_members gm
    where gm.group_id = v_group_id and gm.joined_at <= v_opened_at;

  -- Only APPROVED reflections count toward the gate; pending and flagged never do.
  select count(*) into v_posted_count from reflections
    where day_instance_id = new.day_instance_id and moderation_status = 'approved';

  update day_instances set participation_count = v_posted_count
    where id = new.day_instance_id;

  if v_member_count > 0
     and (v_posted_count::numeric / v_member_count::numeric) * 100 >= v_pct then

    update day_instances set status = 'threshold_met'
      where id = new.day_instance_id and status = 'open';

    get diagnostics v_flipped = row_count;  -- 1 only for the call that actually flips it

    -- Dispatched on the flip AND on every approval after it. The first call writes the
    -- card; later ones let it take in the people who posted once the day was already
    -- open. Without this the pulse is a snapshot of the threshold moment forever.
    perform public.dispatch_edge_function(
      'generate-group-pulse',
      jsonb_build_object('day_instance_id', new.day_instance_id)
    );
  end if;

  -- Everyone who was in the group when its final day opened has posted on it: finish
  -- now rather than making them wait out a 24h window with nothing left to do. Counted
  -- over those members only, so a late joiner's post cannot stand in for a founder's.
  if v_day_index >= v_day_count and v_member_count > 0 and v_challenge_status = 'active' then
    select count(*) into v_members_posted
      from reflections r
      join group_members gm on gm.group_id = v_group_id and gm.user_id = r.user_id
     where r.day_instance_id = new.day_instance_id
       and r.moderation_status = 'approved'
       and gm.joined_at <= v_opened_at;

    if v_members_posted >= v_member_count then
      -- Take the group row before deciding. A pause or end committed by a member while
      -- this approval was in flight must win: once the lock is ours, the status we read
      -- is the current one, and a group that is no longer active is left exactly as the
      -- member put it.
      perform 1 from groups where id = v_group_id for update;
      update groups set challenge_status = 'completed'
        where id = v_group_id and challenge_status = 'active';
      get diagnostics v_closed = row_count;  -- 1 only when it was still active, once

      if v_closed = 1 then
        update day_instances set status = 'complete'
          where id = new.day_instance_id and status in ('open', 'threshold_met');
        perform public.dispatch_edge_function(
          'end-of-challenge-summary',
          jsonb_build_object('group_id', v_group_id)
        );
      end if;
    end if;
  end if;

  return new;
end;
$$;
