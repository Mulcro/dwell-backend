-- A challenge needs two people. Losing one puts the group back to waiting.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

insert into groups (id, name, plan_challenge_id, created_by, challenge_status, consecutive_silent_days, prompt_pending)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Pair',
        '00000000-0000-0000-0000-0000000000a1',
        '11111111-1111-1111-1111-111111111111', 'active', 2, true);

insert into group_members (group_id, user_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222');

insert into day_instances (id, group_id, day_index, date, passage_ref)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'HEB.6.19');

-- One of the two deletes their account.
delete from auth.users where id = '22222222-2222-2222-2222-222222222222';

select is((select challenge_status::text from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'forming', 'a challenge that drops to one member goes back to waiting');
select is((select consecutive_silent_days from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0, 'the silence tally resets with the departure');
select is((select prompt_pending from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  false, 'and any pending prompt is cleared');
select is((select count(*)::int from day_instances where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'the existing day survives, so nothing already written is lost');

-- A third person joining revives it through the ordinary path.
insert into group_members (group_id, user_id)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333');
update groups set challenge_status = 'active' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is((select challenge_status::text from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'active', 'and it can be revived when someone new joins');

-- A finished challenge is not dragged back to forming by a later departure.
insert into groups (id, name, plan_challenge_id, created_by, challenge_status)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Done',
        '00000000-0000-0000-0000-0000000000a1',
        '11111111-1111-1111-1111-111111111111', 'completed');
insert into group_members (group_id, user_id) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333');
delete from group_members
 where group_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
   and user_id = '33333333-3333-3333-3333-333333333333';

select is((select challenge_status::text from groups where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  'completed', 'a completed challenge stays completed');

-- A group still in forming is untouched; it was already waiting.
select is((select count(*)::int from groups where challenge_status = 'forming'),
  0, 'no other group was disturbed');

select * from finish();
rollback;
