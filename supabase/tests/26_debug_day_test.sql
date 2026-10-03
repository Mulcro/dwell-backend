-- debug_advance_day / debug_rewind_day: time travel for the debug UI, one group only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- Stub the dispatcher, as 05 does, so completing the challenge logs instead of POSTing.
create table dispatch_log (name text, body jsonb);
create or replace function public.dispatch_edge_function(p_name text, p_body jsonb)
returns void language plpgsql security definer as $$
begin
  insert into dispatch_log values (p_name, p_body);
end;
$$;

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Debug Crew',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active');
insert into day_instances (group_id, day_index, date, passage_ref, opened_at, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, current_date, 'PSA.34.18', now(), 'open');

-- Forward: the 24h gate and the met threshold are forced, then the real sweep runs.
select is(public.debug_advance_day('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->>'day_index',
  '2', 'advancing a fresh day 1 opens day 2');
select is((select status::text from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and day_index = 1),
  'complete', 'and completes day 1, as the production sweep would');

-- Back: the newest day is dropped and the one before it is current and open again.
select is(public.debug_rewind_day('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->>'day_index',
  '1', 'rewinding lands back on day 1');
select is((select count(*)::int from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'day 2 is gone');
select is((select status::text from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and day_index = 1),
  'open', 'day 1 is open again');

select throws_ok(
  $$select public.debug_rewind_day('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'P0001', null, 'day 1 cannot be rewound');

update groups set challenge_status = 'paused' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select throws_ok(
  $$select public.debug_advance_day('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'P0001', null, 'a paused group does not advance');
update groups set challenge_status = 'active' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- Run the whole 7-day seed plan: six advances reach day 7, the seventh completes it.
do $$
begin
  for i in 1..7 loop
    perform public.debug_advance_day('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  end loop;
end;
$$;
select is((select challenge_status::text from groups
           where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'completed', 'advancing through the final day completes the challenge');
select is((select count(*)::int from dispatch_log where name = 'end-of-challenge-summary'),
  1, 'the end-of-challenge summary is dispatched exactly as in production');

-- A completed challenge rewinds by reopening its final day.
select is(public.debug_rewind_day('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->>'day_index',
  '7', 'rewinding a completed challenge lands on the final day');
select is((select challenge_status::text from groups
           where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'active', 'and the group is active again');
select is((select status::text from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and day_index = 7),
  'open', 'with day 7 open');

-- Debug or not, time travel is never reachable from a client role.
set local role anon;
select throws_ok(
  $$select public.debug_advance_day('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '42501', null, 'anon cannot advance days');
set local role authenticated;
select throws_ok(
  $$select public.debug_rewind_day('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '42501', null, 'a signed-in user cannot rewind days');
reset role;

select * from finish();
rollback;
