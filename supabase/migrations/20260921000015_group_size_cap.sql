-- Groups are capped at 7 members (decided 2026-09-24).
--
-- Enforced by a trigger rather than only in /join-group, because an application-level
-- count is a time-of-check/time-of-use race: two people joining a 6-member group at the
-- same moment would both read 6, both pass, and make 8. Locking the group row inside
-- the trigger serialises joins per group so the count cannot be beaten.

create or replace function public.enforce_group_size()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- Already a member: /join-group upserts so the invite link can be tapped twice, and a
  -- BEFORE INSERT trigger fires before the conflict is detected. Without this exemption
  -- the seventh member would be told the group is full when re-opening their own invite.
  if exists (
    select 1 from group_members
    where group_id = new.group_id and user_id = new.user_id
  ) then
    return new;
  end if;

  -- Serialise concurrent joins to this group. Taking the lock before counting is what
  -- makes the check hold under load.
  perform 1 from groups where id = new.group_id for update;

  select count(*) into v_count from group_members where group_id = new.group_id;

  if v_count >= 7 then
    raise exception 'group is full' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger group_members_size_limit
  before insert on group_members
  for each row execute function public.enforce_group_size();

revoke all on function public.enforce_group_size() from public, anon, authenticated;
