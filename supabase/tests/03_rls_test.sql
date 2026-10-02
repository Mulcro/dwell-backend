-- Row-level security, including the PHASE1 #1/#2 fixes.
--
-- The scenario: alice and bob share a group, carol is a stranger. Day 1 is open,
-- alice has an APPROVED reflection, bob's is still PENDING moderation.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- alice
  ('22222222-2222-2222-2222-222222222222'),  -- bob
  ('33333333-3333-3333-3333-333333333333');  -- carol, not a member

insert into groups (id, name, plan_challenge_id, created_by)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Test Group',
        '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111');

insert into group_members (group_id, user_id, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now() - interval '2 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', now() - interval '2 days');

insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'PSA.34.18', now() - interval '1 day');

insert into reflections (id, user_id, day_instance_id, media_type, content, language, moderation_status) values
  ('eeeeeeee-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'dddddddd-dddd-dddd-dddd-dddddddddddd', 'text', 'alice reflection', 'en', 'approved'),
  ('eeeeeeee-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   'dddddddd-dddd-dddd-dddd-dddddddddddd', 'text', 'bob reflection', 'en', 'pending');

insert into ai_insights (group_id, day_instance_id, target_user_id, scope, type, content) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
   null, 'day_instance', 'group_pulse', 'group-wide pulse'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
   '22222222-2222-2222-2222-222222222222', 'day_instance', 'nudge', 'personal nudge for bob');

-- ---------------------------------------------------------------- alice (approved)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

-- THE LEAK THIS FIXES: the design doc's policy checked neither side's moderation_status,
-- so bob's un-moderated reflection was readable by anyone who had posted.
select is((select count(*)::int from reflections), 1,
  'a group-mate PENDING reflection stays hidden even from someone who posted');

select is((select count(*)::int from users), 2,
  'alice sees herself and her group-mate, not strangers');
select is((select count(*)::int from group_members), 2, 'alice sees her group roster');
select is((select count(*)::int from ai_insights), 1,
  'alice sees the group pulse but not a nudge targeted at bob');

select throws_ok(
  $$insert into reflections (user_id, day_instance_id, media_type, language)
    values ('11111111-1111-1111-1111-111111111111','dddddddd-dddd-dddd-dddd-dddddddddddd','text','en')$$,
  '42501', null,
  'a client cannot insert a reflection directly, so moderation cannot be bypassed'
);

select throws_ok(
  $$update reflections set moderation_status = 'approved'
    where id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  '42501', null,
  'a client cannot approve its own reflection'
);

-- Locked: bob's reflection is not approved, so it cannot be commented on.
select throws_ok(
  $$insert into comments (reflection_id, user_id, content)
    values ('eeeeeeee-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','hi')$$,
  '42501', null,
  'cannot comment on a reflection that is not unlocked'
);

-- ------------------------------------------------------------------ bob (pending)
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', true);

select is((select count(*)::int from reflections), 1,
  'a PENDING reflection does not unlock the group-mates'' approved ones');

-- ------------------------------------------------------------- carol (non-member)
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', true);

select is((select count(*)::int from reflections), 0, 'a non-member sees no reflections');
select is((select count(*)::int from groups), 0, 'a non-member sees no groups');
select is((select count(*)::int from day_instances), 0, 'a non-member sees no days');
select is((select count(*)::int from ai_insights), 0, 'a non-member sees no insights');

-- -------------------------------------------- bob approved: the day is now unlocked
reset role;
update reflections set moderation_status = 'approved'
  where id = 'eeeeeeee-2222-2222-2222-222222222222';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

select is((select count(*)::int from reflections), 2,
  'once both are approved the day unlocks for alice');

-- Replies carry audio and images now, so they go through submit-comment, which moderates
-- first. The unlock rule still decides whether you may reply, and it does that by making
-- the parent reflection visible -- which is the check submit-comment makes.
select throws_ok(
  $$insert into comments (reflection_id, user_id, content)
    values ('eeeeeeee-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','encouragement')$$,
  '42501', null, 'a reply can no longer be inserted directly, moderated or not'
);

select lives_ok(
  $$insert into reactions (reflection_id, user_id, emoji)
    values ('eeeeeeee-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','🙏')$$,
  'can react to an unlocked reflection'
);

-- Identity is never taken from the request body: you cannot write as someone else.
select throws_ok(
  $$insert into comments (reflection_id, user_id, content)
    values ('eeeeeeee-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222','as bob')$$,
  '42501', null,
  'cannot post a comment as another user'
);

reset role;
select * from finish();
rollback;
