-- Groups need at least 2 people to be a challenge (decided 2026-09-24).
--
-- Going up, /join-group already handles it: a group stays `forming` until the second
-- member arrives, and that join is what opens Day 1.
--
-- Coming down was unguarded. Deleting an account cascades its group_members row away,
-- and a 2-person group silently became a 1-person `active` challenge -- where the
-- threshold is trivially met by the last member alone, and the whole premise of posting
-- before you can read collapses.
--
-- Such a group reverts to `forming`: not abandoned, because the remaining member should
-- be able to invite someone else and carry on. /join-group already revives a `forming`
-- group on the second member, and re-opening Day 1 is a no-op when it exists, so no new
-- code path is needed to resume.

create or replace function public.enforce_group_minimum()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  select count(*) into v_count from group_members where group_id = old.group_id;

  if v_count < 2 then
    update groups
       set challenge_status = 'forming',
           -- The prompt and silence tally belong to the group that just lost someone.
           prompt_pending = false,
           consecutive_silent_days = 0
     where id = old.group_id
       -- A finished challenge stays finished; this is only for live ones.
       and challenge_status in ('active', 'paused');
  end if;

  return old;
end;
$$;

create trigger group_members_minimum
  after delete on group_members
  for each row execute function public.enforce_group_minimum();

revoke all on function public.enforce_group_minimum() from public, anon, authenticated;
