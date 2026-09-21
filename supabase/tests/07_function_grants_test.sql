-- Privileged SECURITY DEFINER functions must not be reachable from a client role.
--
-- Regression test: Postgres grants EXECUTE to PUBLIC by default, so before
-- 20260921000009 an anon caller could advance every group's days, or make the database
-- POST to any Edge Function carrying the service role key.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

set local role anon;

select throws_ok(
  $$select public.open_ready_next_days()$$,
  '42501', null, 'anon cannot advance days');
select throws_ok(
  $$select public.dispatch_edge_function('generate-group-pulse', '{}'::jsonb)$$,
  '42501', null, 'anon cannot make the database call an Edge Function');

set local role authenticated;

select throws_ok(
  $$select public.open_ready_next_days()$$,
  '42501', null, 'a signed-in user cannot advance days');
select throws_ok(
  $$select public.dispatch_edge_function('generate-group-pulse', '{}'::jsonb)$$,
  '42501', null, 'a signed-in user cannot make the database call an Edge Function');

-- The RLS helpers stay callable on purpose: they answer only about the caller, and the
-- policies themselves depend on them.
select lives_ok(
  $$select public.is_group_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'the membership helper remains callable');
select lives_ok(
  $$select public.is_reflection_unlocked('eeeeeeee-1111-1111-1111-111111111111')$$,
  'the unlock helper remains callable');

reset role;
select * from finish();
rollback;
