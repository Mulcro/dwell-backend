-- KAN-46: one challenge at a time, enforced by the database so two requests racing
-- past the functions' check cannot both land.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Going', '00000000-0000-0000-0000-0000000000a3',
   '11111111-1111-1111-1111-111111111111', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Next', '00000000-0000-0000-0000-0000000000a3',
   '22222222-2222-2222-2222-222222222222', 'forming'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Done', '00000000-0000-0000-0000-0000000000a3',
   '22222222-2222-2222-2222-222222222222', 'completed');

insert into group_members (group_id, user_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111');

select throws_ok(
  $$insert into group_members (group_id, user_id) values
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111')$$,
  'DG409', null, 'someone in an active group cannot be added to another');

select lives_ok(
  $$insert into group_members (group_id, user_id) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111')
    on conflict (group_id, user_id) do nothing$$,
  'tapping the invite to your own group again is still a no-op');

-- Bob's only group has finished: that membership stays his but does not hold him back.
insert into group_members (group_id, user_id) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222');
select lives_ok(
  $$insert into group_members (group_id, user_id) values
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222')$$,
  'a finished group never holds anyone back');

update groups set challenge_status = 'paused' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select throws_ok(
  $$insert into group_members (group_id, user_id) values
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111')$$,
  'DG409', null, 'a paused challenge is still going');

update groups set challenge_status = 'abandoned' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select lives_ok(
  $$insert into group_members (group_id, user_id) values
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111')$$,
  'once it has ended, they can join the next');

-- Membership in a forming group counts as going too: no second group while one forms.
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Forming A', '00000000-0000-0000-0000-0000000000a3',
   '33333333-3333-3333-3333-333333333333', 'forming'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Forming B', '00000000-0000-0000-0000-0000000000a3',
   '33333333-3333-3333-3333-333333333333', 'forming');
insert into group_members (group_id, user_id) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$insert into group_members (group_id, user_id) values
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '33333333-3333-3333-3333-333333333333')$$,
  'DG409', null, 'a forming group holds them back as well');

select is(
  (select count(*)::int from pg_proc p
    where p.proname = 'enforce_one_ongoing_group'
      and pg_get_functiondef(p.oid) like '%pg_advisory_xact_lock%'),
  1, 'the check runs under a per-person lock, so concurrent requests take turns');

select * from finish();
rollback;
