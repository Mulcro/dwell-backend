-- KAN-46: my_groups() lists the caller's groups, the current one first, with the group's
-- own counts.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- alice: one finished group, one new
  ('22222222-2222-2222-2222-222222222222'),  -- bob: only the finished one
  ('33333333-3333-3333-3333-333333333333');  -- carol: none

-- A finished challenge on an unlisted plan, two members, two approved posts and one
-- pending.
insert into groups (id, name, plan_challenge_id, created_by, challenge_status, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Round One',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'completed',
   now() - interval '10 days');
insert into group_members (group_id, user_id, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now() - interval '10 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', now() - interval '10 days');
insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at, status) values
  ('dddddddd-aaaa-aaaa-aaaa-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   7, current_date, 'REV.21.4', now() - interval '3 days', 'complete');
insert into reflections (user_id, day_instance_id, media_type, content, language, moderation_status, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd', 'text', 'a', 'en', 'approved', now() - interval '2 days'),
  ('22222222-2222-2222-2222-222222222222', 'dddddddd-aaaa-aaaa-aaaa-dddddddddddd', 'text', 'b', 'en', 'approved', now() - interval '2 days');
insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at) values
  ('dddddddd-aaaa-aaaa-aaaa-ddddddddddd6', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   6, current_date, 'JAS.1.2-4', now() - interval '4 days');
insert into reflections (user_id, day_instance_id, media_type, content, language, moderation_status) values
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-aaaa-aaaa-aaaa-ddddddddddd6', 'text', 'c', 'en', 'pending');

-- Alice's next group: forming, created before the old one's last post, yet still first.
insert into groups (id, name, plan_challenge_id, created_by, challenge_status, created_at) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Round Two',
   '00000000-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'forming',
   now() - interval '5 days');
insert into group_members (group_id, user_id) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111');

set local role authenticated;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
select is((select count(*)::int from public.my_groups()), 2, 'alice sees both of her groups');
select is((select name from public.my_groups() limit 1), 'Round Two',
  'the group still going comes first, even though the finished one was active more recently');
select is((select plan_title from public.my_groups() where name = 'Round Two'), 'Be Still',
  'with its plan');
select is((select member_count from public.my_groups() where name = 'Round One'), 2,
  'the finished group counts its members');
select is((select reflection_count from public.my_groups() where name = 'Round One'), 2,
  'and its approved reflections only, across every day');
select is((select plan_title from public.my_groups() where name = 'Round One'), 'When Life Gets Hard',
  'an unlisted plan still names a group that read it');
select ok((select last_activity_at from public.my_groups() where name = 'Round One') > now() - interval '3 days',
  'last activity is the latest post or opened day, not the creation date');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', true);
select is((select count(*)::int from public.my_groups()), 1, 'bob sees only the group he is in');
select is((select reflection_count from public.my_groups()), 2,
  'with the whole group''s count, not just what his unlock lets him read');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', true);
select is((select count(*)::int from public.my_groups()), 0, 'carol, in no group, sees none');

set local role anon;
select throws_ok($$select * from public.my_groups()$$, '42501', null,
  'it is not callable without signing in');

reset role;
select * from finish();
rollback;
