-- KAN-63: one member nudge per sender per group per day, and no client access.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Nudgers', '00000000-0000-0000-0000-0000000000a3',
   '11111111-1111-1111-1111-111111111111', 'active');
insert into day_instances (id, group_id, day_index, date, passage_ref) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, current_date, 'PSA.46.1-11'),
  ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2, current_date, '1KI.19.9-13');

insert into group_nudges (group_id, day_instance_id, sender_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111');

select throws_ok(
  $$insert into group_nudges (group_id, day_instance_id, sender_id) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111')$$,
  '23505', null, 'the same sender cannot nudge the same group twice on one day');
select lives_ok(
  $$insert into group_nudges (group_id, day_instance_id, sender_id) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111')$$,
  'but can on the next day');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
select is((select count(*)::int from group_nudges), 0, 'clients cannot read nudges, even their own');
select throws_ok(
  $$insert into group_nudges (group_id, day_instance_id, sender_id) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'or write them: only the function can');

reset role;
select * from finish();
rollback;
