-- KAN-50: a group that continues a finished one is offered to that group's members until
-- they join or it ends.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Fixtures place one person in several live groups; the one-group rule is tested in 32.
alter table group_members disable trigger one_ongoing_group;

insert into auth.users (id, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', '{"name":"Mulero"}'),  -- starts the new plan
  ('22222222-2222-2222-2222-222222222222', '{"name":"Taylor"}'),  -- has not joined it
  ('33333333-3333-3333-3333-333333333333', '{"name":"Priya"}'),   -- already joined it
  ('44444444-4444-4444-4444-444444444444', '{"name":"Stranger"}'); -- never in the old group

insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Gallop', '00000000-0000-0000-0000-0000000000a3',
   '11111111-1111-1111-1111-111111111111', 'completed');
insert into group_members (group_id, user_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333');

insert into groups (id, name, plan_challenge_id, created_by, challenge_status, continues_group_id, created_at) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Gallop', '00000000-0000-0000-0000-0000000000a4',
   '11111111-1111-1111-1111-111111111111', 'active', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   now() - interval '1 hour');
insert into group_members (group_id, user_id) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333');

select has_column('public', 'groups', 'continues_group_id', 'a group can name the group it continues');

set local role authenticated;

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', true);
select is((select count(*)::int from public.my_continuations()), 1,
  'a previous member who has not joined sees the invitation');
select is((select created_by_name || ' / ' || plan_title || ' / ' || member_count
             from public.my_continuations()),
  'Mulero / Better Together / 2', 'with who started it, the plan, and how many are in');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
select is((select count(*)::int from public.my_continuations()), 0, 'the creator sees none');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', true);
select is((select count(*)::int from public.my_continuations()), 0, 'nor does someone who already joined');
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444"}', true);
select is((select count(*)::int from public.my_continuations()), 0,
  'nor anyone who was never in the old group');

-- A second member starts their own successor later: both show, newest first.
reset role;
insert into groups (id, name, plan_challenge_id, created_by, challenge_status, continues_group_id) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Gallop Again', '00000000-0000-0000-0000-0000000000a5',
   '33333333-3333-3333-3333-333333333333', 'forming', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into group_members (group_id, user_id) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', true);
-- Ordered by the position the function returned each row in, so this fails if the
-- function itself stops returning newest first.
select is((select array_agg(name order by ordinality)
             from public.my_continuations() with ordinality),
  array['Gallop Again', 'Gallop'], 'several successors all show, newest first');

-- Once a successor has ended it is no longer offered.
reset role;
update groups set challenge_status = 'abandoned' where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', true);
select is((select array_agg(name) from public.my_continuations()), array['Gallop'],
  'an ended successor stops appearing');

select ok(not exists (
    select 1 from information_schema.routines r
      join information_schema.parameters p on p.specific_name = r.specific_name
     where r.routine_name = 'my_continuations' and p.parameter_name ilike '%invite%'),
  'the invitation never carries the invite code');

set local role anon;
select throws_ok($$select * from public.my_continuations()$$, '42501', null,
  'it is not callable without signing in');

reset role;
select * from finish();
rollback;
