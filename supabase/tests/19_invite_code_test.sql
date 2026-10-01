-- Invite codes are typed into six boxes on the join screen, so the format the database
-- mints has to be the format the client can accept.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- The auth trigger makes the public.users row; inserting it directly skips the FK.
insert into auth.users (id, raw_user_meta_data)
values ('22222222-2222-2222-2222-222222222222', '{"name": "Codes Tester"}'::jsonb);
insert into groups (id, name, plan_challenge_id, created_by)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Codes',
        '00000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222');

select is((select length(invite_token) from groups where name = 'Codes'),
  6, 'a new group gets a six character code');

-- No vowels and no 0/1/I/L/O: a code is read aloud, and must not land on a word.
select matches((select invite_token from groups where name = 'Codes'),
  '^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$', 'from the unambiguous alphabet');

select throws_ok(
  $$update groups set invite_token = 'abc' where name = 'Codes'$$,
  '23514', null, 'a short or lower-case code is refused outright');
select throws_ok(
  $$update groups set invite_token = 'AEIOU2' where name = 'Codes'$$,
  '23514', null, 'and so is one with vowels in it');

-- 28^6 is ~482 million; the generator still has to not repeat itself.
select is(
  (select count(distinct public.generate_invite_code())::int from generate_series(1, 200)),
  200, 'two hundred codes in a row are all different');

select is((select count(*)::int from groups where invite_token is null),
  0, 'every group has one');

select * from finish();
rollback;
