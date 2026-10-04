-- KAN-19: the picker shows only listed plans, but a group already reading an unlisted
-- plan can still see it and its days.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- alice, in a group on an unlisted plan
  ('33333333-3333-3333-3333-333333333333');  -- carol, in no group

insert into groups (id, name, plan_challenge_id, created_by)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Old Plan Crew',
        '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111');
insert into group_members (group_id, user_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111');

select has_column('public', 'plan_challenges', 'listed', 'a plan can be unlisted');
select is((select count(*)::int from plan_challenges where not listed), 2,
  'the two plans without design copy are unlisted');
select is((select listed from plan_challenges where title = 'Be Still'), true,
  'and the design plans are listed');

-- ------------------------------------------------------------ carol, no groups
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', true);

select is((select count(*)::int from plan_challenges), 3,
  'the picker sees only the three listed plans');
select is((select count(*)::int from plan_challenges where id = '00000000-0000-0000-0000-0000000000a1'), 0,
  'an unlisted plan is invisible to someone not reading it');
select is((select count(*)::int from plan_days where plan_challenge_id = '00000000-0000-0000-0000-0000000000a1'), 0,
  'and so are its days');

-- ------------------------------------------------ alice, in a group on that plan
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

select is((select count(*)::int from plan_challenges where id = '00000000-0000-0000-0000-0000000000a1'), 1,
  'a member of a group on the unlisted plan still sees it');
select is((select count(*)::int from plan_days where plan_challenge_id = '00000000-0000-0000-0000-0000000000a1'), 7,
  'with all of its days');

reset role;
select * from finish();
rollback;
