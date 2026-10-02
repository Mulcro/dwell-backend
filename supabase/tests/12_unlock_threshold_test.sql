-- The unlock rule needs BOTH halves (MVP Spec §5): the group cleared the day, AND the
-- caller's own approved reflection counts toward it. Posting alone is not enough.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- alice
  ('22222222-2222-2222-2222-222222222222'),  -- bob
  ('33333333-3333-3333-3333-333333333333');  -- carol, silent

-- Three members at 100%: two approved reflections do NOT clear the day.
insert into groups (id, name, plan_challenge_id, created_by, challenge_status, catch_up_threshold_pct)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Strict Crew',
        '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111',
        'active', 100);

-- Name the three explicitly. Selecting from auth.users would sweep in any user left
-- behind by another suite and quietly change the member count this test depends on.
insert into group_members (group_id, user_id, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now() - interval '2 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', now() - interval '2 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', now() - interval '2 days');

insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'PSA.34.18', now() - interval '1 hour');

insert into reflections (id, user_id, day_instance_id, media_type, content, language) values
  ('eeeeeeee-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'dddddddd-dddd-dddd-dddd-dddddddddddd', 'text', 'alice', 'en'),
  ('eeeeeeee-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   'dddddddd-dddd-dddd-dddd-dddddddddddd', 'text', 'bob', 'en');

update reflections set moderation_status = 'approved'
  where id in ('eeeeeeee-1111-1111-1111-111111111111', 'eeeeeeee-2222-2222-2222-222222222222');

-- 2 of 3 at a 100% threshold: the day is still open.
select is((select status::text from day_instances where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  'open', 'two of three at 100% does not clear the day');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

-- THE FIX: alice posted and was approved, but the group has not cleared the day, so
-- bob's reflection stays shut. Before this migration she could read it.
select is((select count(*)::int from reflections), 1,
  'posting does not unlock the day on its own -- the group must clear it too');
select is((select count(*)::int from reflections where user_id = auth.uid()), 1,
  'but you can always see what you wrote yourself');

-- Commenting is gated by the same rule, so it cannot outrun reading.
select throws_ok(
  $$insert into comments (reflection_id, user_id, content)
    values ('eeeeeeee-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','early')$$,
  '42501', null, 'cannot comment on a day the group has not cleared');

-- ------------------------------------------------ carol posts: the day is cleared
reset role;
insert into reflections (id, user_id, day_instance_id, media_type, content, language)
values ('eeeeeeee-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333',
        'dddddddd-dddd-dddd-dddd-dddddddddddd', 'text', 'carol', 'en');
update reflections set moderation_status = 'approved'
  where id = 'eeeeeeee-3333-3333-3333-333333333333';

select is((select status::text from day_instances where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  'threshold_met', 'the third reflection clears the day');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

select is((select count(*)::int from reflections), 3,
  'now the whole day opens to alice');
-- Replies now carry audio and images, so they cannot be a plain insert: submit-comment
-- moderates first and is the only way in. What the unlock rule still decides is whether
-- you may reply at all, and that is exactly the reflection being visible to you -- which
-- is the check submit-comment makes, through this same policy.
select is(
  (select count(*)::int from reflections where id = 'eeeeeeee-2222-2222-2222-222222222222'),
  1, 'and the reflection is now visible, so replying is allowed');
select throws_ok(
  $$insert into comments (reflection_id, user_id, content)
    values ('eeeeeeee-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','well said')$$,
  '42501', null, 'but only through submit-comment, never a direct insert');

-- A member who never posted stays locked out even though the group cleared the day.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000"}', true);
select is((select count(*)::int from reflections), 0,
  'a stranger sees nothing regardless of the day status');

reset role;
select * from finish();
rollback;
