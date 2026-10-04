-- check_day_threshold: the gate that decides when a day is "met".
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- These scenarios put one person in several live groups to keep the fixture small. One
-- challenge at a time is tested on its own in 32; here it is switched off, inside this
-- transaction only.
alter table group_members disable trigger one_ongoing_group;

-- Record dispatches instead of making them, so we can assert group-pulse fires exactly
-- once. Replaced inside the transaction, so the real helper is restored on rollback.
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
  ('33333333-3333-3333-3333-333333333333'),  -- carol, joins late
  ('44444444-4444-4444-4444-444444444444'),  -- dave
  ('55555555-5555-5555-5555-555555555555');  -- erin

-- ---------------------------------------------- Group A: 2 members, 50% threshold
insert into groups (id, name, plan_challenge_id, created_by, catch_up_threshold_pct, challenge_status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Group A',
        '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 50, 'active');

insert into group_members (group_id, user_id, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now() - interval '2 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', now() - interval '2 days');

insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at)
values ('dddddddd-aaaa-aaaa-aaaa-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'PSA.34.18', now() - interval '1 day');

insert into reflections (id, user_id, day_instance_id, media_type, language) values
  ('eeeeeeee-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'dddddddd-aaaa-aaaa-aaaa-dddddddddddd', 'text', 'en'),
  ('eeeeeeee-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   'dddddddd-aaaa-aaaa-aaaa-dddddddddddd', 'text', 'en');

-- A pending reflection is invisible to the gate: the insert itself must change nothing.
select is((select status::text from day_instances where id = 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd'),
  'open', 'a pending reflection does not open the gate');
select is((select participation_count from day_instances where id = 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd'),
  0, 'a pending reflection is not counted');

-- Approval is what fires the trigger. 1 of 2 members = 50%, which meets the threshold.
update reflections set moderation_status = 'approved'
  where id = 'eeeeeeee-1111-1111-1111-111111111111';

select is((select status::text from day_instances where id = 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd'),
  'threshold_met', 'approval at the threshold flips the day');
select is((select participation_count from day_instances where id = 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd'),
  1, 'the approved reflection is counted');
select is((select count(*)::int from dispatch_log where name = 'generate-group-pulse'),
  1, 'group pulse is dispatched once');

-- A later approval dispatches again, on purpose. The pulse used to be written once, at
-- the instant the day tipped over -- which with a 50% threshold is typically half the
-- group, so anyone posting afterwards never appeared on the card at all. It has to catch
-- up, and generate-group-pulse is what decides whether there is anything new to say.
update reflections set moderation_status = 'approved'
  where id = 'eeeeeeee-2222-2222-2222-222222222222';

select is((select participation_count from day_instances where id = 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd'),
  2, 'the later approval still updates the count');
select is((select count(*)::int from dispatch_log where name = 'generate-group-pulse'),
  2, 'and dispatches the pulse again so it can take the new reflection in');

-- ------------------------------- Group B: a late joiner must not change the day's math
insert into groups (id, name, plan_challenge_id, created_by, catch_up_threshold_pct, challenge_status)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Group B',
        '00000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444', 100, 'active');

insert into group_members (group_id, user_id, joined_at) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444', now() - interval '2 days'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55555555-5555-5555-5555-555555555555', now() - interval '2 days'),
  -- carol joins AFTER the day opened; at 100% she would block it if she were counted
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', now());

insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at)
values ('dddddddd-bbbb-bbbb-bbbb-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        1, current_date, 'PSA.34.18', now() - interval '1 day');

insert into reflections (id, user_id, day_instance_id, media_type, language) values
  ('eeeeeeee-4444-4444-4444-444444444444', '44444444-4444-4444-4444-444444444444',
   'dddddddd-bbbb-bbbb-bbbb-dddddddddddd', 'text', 'en'),
  ('eeeeeeee-5555-5555-5555-555555555555', '55555555-5555-5555-5555-555555555555',
   'dddddddd-bbbb-bbbb-bbbb-dddddddddddd', 'text', 'en');

update reflections set moderation_status = 'approved'
  where id in ('eeeeeeee-4444-4444-4444-444444444444', 'eeeeeeee-5555-5555-5555-555555555555');

select is((select status::text from day_instances where id = 'dddddddd-bbbb-bbbb-bbbb-dddddddddddd'),
  'threshold_met', 'a member who joined after the day opened does not raise the bar');

-- ------------------------------------------- Group C: flagged content never counts
insert into groups (id, name, plan_challenge_id, created_by, catch_up_threshold_pct, challenge_status)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Group C',
        '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 100, 'active');

insert into group_members (group_id, user_id, joined_at) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', now() - interval '2 days'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', now() - interval '2 days');

insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at)
values ('dddddddd-cccc-cccc-cccc-dddddddddddd', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        1, current_date, 'PSA.34.18', now() - interval '1 day');

insert into reflections (id, user_id, day_instance_id, media_type, language) values
  ('eeeeeeee-1111-cccc-cccc-111111111111', '11111111-1111-1111-1111-111111111111',
   'dddddddd-cccc-cccc-cccc-dddddddddddd', 'text', 'en'),
  ('eeeeeeee-2222-cccc-cccc-222222222222', '22222222-2222-2222-2222-222222222222',
   'dddddddd-cccc-cccc-cccc-dddddddddddd', 'text', 'en');

update reflections set moderation_status = 'flagged'
  where id = 'eeeeeeee-1111-cccc-cccc-111111111111';
update reflections set moderation_status = 'approved'
  where id = 'eeeeeeee-2222-cccc-cccc-222222222222';

select is((select status::text from day_instances where id = 'dddddddd-cccc-cccc-cccc-dddddddddddd'),
  'open', 'flagged content cannot carry a day over the threshold');
select is((select participation_count from day_instances where id = 'dddddddd-cccc-cccc-cccc-dddddddddddd'),
  1, 'only the approved reflection is counted');

select * from finish();
rollback;
