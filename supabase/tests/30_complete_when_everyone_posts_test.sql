-- KAN-42: when everyone has posted on the final day the challenge completes at once;
-- otherwise the final day waits for the sweep exactly as before.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

create table dispatch_log (name text, body jsonb);
create or replace function public.dispatch_edge_function(p_name text, p_body jsonb)
returns void language plpgsql as $$
begin
  insert into dispatch_log values (p_name, p_body);
end;
$$;

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- alice
  ('22222222-2222-2222-2222-222222222222'),  -- bob
  ('33333333-3333-3333-3333-333333333333'),  -- carol, joins after the final day opened
  ('44444444-4444-4444-4444-444444444444'),  -- dave
  ('55555555-5555-5555-5555-555555555555');  -- erin

create function approve(p_id uuid, p_user uuid, p_day uuid) returns void language plpgsql as $$
begin
  insert into reflections (id, user_id, day_instance_id, media_type, content, language)
  values (p_id, p_user, p_day, 'text', 'words', 'en');
  update reflections set moderation_status = 'approved' where id = p_id;
end;
$$;

create function summaries_for(p_group uuid) returns int language sql as $$
  select count(*)::int from dispatch_log
   where name = 'end-of-challenge-summary' and body->>'group_id' = p_group::text;
$$;

-- --------------------------------------------- A: two founders on day 7, a late joiner
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Finishing Crew',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active');
insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at) values
  ('dddddddd-aaaa-aaaa-aaaa-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   7, current_date, 'REV.21.4', now() - interval '1 hour');
insert into group_members (group_id, user_id, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now() - interval '7 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', now() - interval '7 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', now() - interval '10 minutes');

select approve('eeeeeeee-0001-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd');
select is((select status::text from day_instances where id = 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd'),
  'threshold_met', 'one of two founders clears the threshold');
select is((select challenge_status::text from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'active', 'but the challenge is not over');
select is(summaries_for('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 0, 'and no summary is dispatched');

-- The late joiner posting does not stand in for the founder who has not.
select approve('eeeeeeee-0001-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd');
select is((select challenge_status::text from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'active', 'a late joiner posting does not complete it');
select is(summaries_for('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 0, 'still no summary');

select approve('eeeeeeee-0001-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd');
select is((select status::text from day_instances where id = 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd'),
  'complete', 'the second founder posting completes the final day');
select is((select challenge_status::text from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'completed', 'and the challenge, with no 24h wait');
select is(summaries_for('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 1, 'and the summary is dispatched once');

-- The sweep later finds nothing to do: the day is complete, not threshold_met.
update day_instances set opened_at = now() - interval '25 hours'
 where id = 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd';
select public.open_ready_next_days();
select is(summaries_for('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 1, 'the cron does not dispatch a second summary');
select is((select count(*)::int from day_instances where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'and opens nothing');

-- ------------------------------------------------- B: everyone posts, but on day 3
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Midway Crew',
   '00000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444', 'active');
insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at) values
  ('dddddddd-bbbb-bbbb-bbbb-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   3, current_date, 'ROM.8.28', now() - interval '1 hour');
insert into group_members (group_id, user_id, joined_at) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444', now() - interval '3 days'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55555555-5555-5555-5555-555555555555', now() - interval '3 days');
select approve('eeeeeeee-0002-0000-0000-000000000004', '44444444-4444-4444-4444-444444444444', 'dddddddd-bbbb-bbbb-bbbb-dddddddddddd');
select approve('eeeeeeee-0002-0000-0000-000000000005', '55555555-5555-5555-5555-555555555555', 'dddddddd-bbbb-bbbb-bbbb-dddddddddddd');
select is((select status::text from day_instances where id = 'dddddddd-bbbb-bbbb-bbbb-dddddddddddd'),
  'threshold_met', 'everyone posting on a middle day only meets its threshold');
select is((select challenge_status::text from groups where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  'active', 'and the challenge carries on');

-- ------------------------------ C: final day, threshold met but not everyone: the sweep
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Waiting Crew',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active');
insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at) values
  ('dddddddd-cccc-cccc-cccc-dddddddddddd', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   7, current_date, 'REV.21.4', now() - interval '25 hours');
insert into group_members (group_id, user_id, joined_at) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', now() - interval '7 days'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', now() - interval '7 days'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '44444444-4444-4444-4444-444444444444', now() - interval '7 days');
select approve('eeeeeeee-0003-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-cccc-cccc-cccc-dddddddddddd');
select approve('eeeeeeee-0003-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'dddddddd-cccc-cccc-cccc-dddddddddddd');
select is((select challenge_status::text from groups where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  'active', 'two of three on the final day is threshold-met, not finished');
select public.open_ready_next_days();
select is((select challenge_status::text from groups where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  'completed', 'the 24h path still completes it');
select is(summaries_for('cccccccc-cccc-cccc-cccc-cccccccccccc'), 1, 'with one summary');

-- ---------------------------------------------- D: a paused group does not complete
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Paused Crew',
   '00000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444', 'paused');
insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at) values
  ('dddddddd-eeee-eeee-eeee-dddddddddddd', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   7, current_date, 'REV.21.4', now() - interval '1 hour');
insert into group_members (group_id, user_id, joined_at) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '44444444-4444-4444-4444-444444444444', now() - interval '7 days'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '55555555-5555-5555-5555-555555555555', now() - interval '7 days');
select approve('eeeeeeee-0004-0000-0000-000000000004', '44444444-4444-4444-4444-444444444444', 'dddddddd-eeee-eeee-eeee-dddddddddddd');
select approve('eeeeeeee-0004-0000-0000-000000000005', '55555555-5555-5555-5555-555555555555', 'dddddddd-eeee-eeee-eeee-dddddddddddd');
select is((select challenge_status::text from groups where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  'paused', 'a paused challenge is not completed from under the group');
select is(summaries_for('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 0, 'and gets no summary');

-- -------------------------- E: a founder who left cannot hold the challenge open
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Departed Crew',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active');
insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at) values
  ('dddddddd-ffff-ffff-ffff-dddddddddddd', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
   7, current_date, 'REV.21.4', now() - interval '1 hour');
insert into group_members (group_id, user_id, joined_at) values
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', '11111111-1111-1111-1111-111111111111', now() - interval '7 days'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', '22222222-2222-2222-2222-222222222222', now() - interval '7 days'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', '55555555-5555-5555-5555-555555555555', now() - interval '7 days');
select approve('eeeeeeee-0005-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-ffff-ffff-ffff-dddddddddddd');
-- Erin leaves after the final day opened; she can no longer post, so she no longer counts.
delete from group_members
 where group_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff' and user_id = '55555555-5555-5555-5555-555555555555';
select is((select challenge_status::text from groups where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  'active', 'one of the two remaining founders is not everyone');
select approve('eeeeeeee-0005-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'dddddddd-ffff-ffff-ffff-dddddddddddd');
select is((select challenge_status::text from groups where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  'completed', 'both remaining founders are: a member who left cannot hold the challenge open');

select * from finish();
rollback;
