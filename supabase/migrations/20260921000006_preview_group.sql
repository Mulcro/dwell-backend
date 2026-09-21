-- Public, unauthenticated invite preview: lets the in-browser join flow show
-- "You've been invited to [Group] doing [Plan]" before the visitor signs in or installs.
--
-- Deliberately returns only the group name and plan title. It is the single function
-- granted to anon, so it must never widen beyond those two non-sensitive columns.

create or replace function public.preview_group(token text)
returns table (name text, plan_title text)
language sql
security definer
stable
set search_path = public
as $$
  select g.name, pc.title
  from groups g
  join plan_challenges pc on pc.id = g.plan_challenge_id
  where g.invite_token = token
$$;

revoke all on function public.preview_group(text) from public;
grant execute on function public.preview_group(text) to anon, authenticated;
