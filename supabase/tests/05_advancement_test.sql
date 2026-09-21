-- open_ready_next_days: advancement is threshold-gated AND paced one-per-24h.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

create table dispatch_log (name text, body jsonb);

create or replace function public.dispatch_edge_function(p_name text, p_body jsonb)
returns void language plpgsql as $$
begin
  insert into dispatch_log values (p_name, p_body);
end;
$$;

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');

-- Four groups, each parked at a different point in the advancement rule.
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Met but too recent',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Old but never met',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Ready to advance',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'On its final day',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Paused mid-challenge',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'paused');

insert into day_instances (group_id, day_index, date, passage_ref, opened_at, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, current_date, 'HEB.6.19', now() - interval '1 hour', 'threshold_met'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, current_date, 'HEB.6.19', now() - interval '2 days', 'open'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 1, current_date, 'HEB.6.19', now() - interval '25 hours', 'threshold_met'),
  -- day 7 of a 7-day plan: clearing it ends the challenge rather than opening day 8
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 7, current_date, 'REV.21.4-5', now() - interval '25 hours', 'threshold_met'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 1, current_date, 'HEB.6.19', now() - interval '25 hours', 'threshold_met');

select public.open_ready_next_days();

-- Paced: meeting the threshold is not enough, the day must also have run its 24 hours.
select is((select status::text from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and day_index = 1),
  'threshold_met', 'a day met less than 24h ago is not completed yet');
select is((select count(*)::int from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'no next day opens before the 24h mark');

-- Gated: time alone never advances a day that the group never cleared.
select is((select count(*)::int from day_instances
           where group_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1, 'a day that never met its threshold does not advance on age alone');

-- Both conditions satisfied: the day closes and the next one opens from plan_days.
select is((select status::text from day_instances
           where group_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and day_index = 1),
  'complete', 'the cleared day is marked complete');
select is((select passage_ref from day_instances
           where group_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and day_index = 2),
  'ISA.40.31', 'the next passage is copied from the plan');
select is((select status::text from day_instances
           where group_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and day_index = 2),
  'open', 'the next day opens');

-- Final day: end the challenge instead of opening a day the plan does not have.
select is((select challenge_status::text from groups where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  'completed', 'clearing the final day completes the challenge');
select is((select count(*)::int from day_instances
           where group_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  1, 'no day 8 is invented past the end of the plan');
select is((select count(*)::int from dispatch_log where name = 'end-of-challenge-summary'),
  1, 'the end-of-challenge summary is dispatched');

-- A paused group freezes: cron keeps running but must not move it along.
select is((select count(*)::int from day_instances
           where group_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  1, 'a paused group does not advance');

select * from finish();
rollback;
