-- Deleting an account leaves the groups it started intact for everyone else.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- alice, the creator
  ('22222222-2222-2222-2222-222222222222');  -- bob, still using the group

insert into groups (id, name, plan_challenge_id, created_by, challenge_status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Morning Crew',
        '00000000-0000-0000-0000-0000000000a1',
        '11111111-1111-1111-1111-111111111111', 'active');

insert into group_members (group_id, user_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222');

insert into day_instances (id, group_id, day_index, date, passage_ref)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'HEB.6.19');

-- The creator closes their account. This must simply work.
select lives_ok(
  $$delete from auth.users where id = '11111111-1111-1111-1111-111111111111'$$,
  'the creator of a group can delete their account'
);

select is((select count(*)::int from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'the group survives its creator');
select is((select created_by from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  null, 'only the creator attribution is cleared');
select is((select count(*)::int from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'the shared history survives');

-- The departing member's own membership goes with them, though.
select is((select count(*)::int from group_members
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'the deleted account is no longer a member');

select * from finish();
rollback;
