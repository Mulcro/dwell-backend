-- KAN-46, enforced where it can hold. The functions check "one challenge at a time"
-- before they write, but two requests from one person can both pass that check, so the
-- database makes the final call: adding a membership takes a per-person lock, then
-- refuses if that person is already in another group whose challenge has not ended.
-- The lock makes concurrent joins or creates for the same person run one after the
-- other; the second sees the first's committed membership and is refused.

create or replace function public.enforce_one_ongoing_group()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('one_ongoing_group:' || new.user_id::text, 0));

  -- A plpgsql statement takes a fresh snapshot, so this sees memberships committed while
  -- we waited for the lock.
  if exists (
    select 1
      from group_members gm
      join groups g on g.id = gm.group_id
     where gm.user_id = new.user_id
       and gm.group_id <> new.group_id
       and g.challenge_status not in ('completed', 'abandoned', 'expired_incomplete')
  ) then
    raise exception 'already in a group whose challenge is still going'
      using errcode = 'DG409';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_one_ongoing_group() from public, anon, authenticated;

create trigger one_ongoing_group
  before insert on group_members
  for each row execute function public.enforce_one_ongoing_group();
