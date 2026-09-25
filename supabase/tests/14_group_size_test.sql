-- Groups hold at most 7 members.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 9) n;

insert into groups (id, name, plan_challenge_id, created_by)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Full House',
        '00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-000000000001');

-- Seven fit.
select lives_ok(
  $$insert into group_members (group_id, user_id)
    select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
           ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
    from generate_series(1, 7) n$$,
  'seven members fit');

select is((select count(*)::int from group_members
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  7, 'all seven landed');

-- The eighth does not.
select throws_ok(
  $$insert into group_members (group_id, user_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000008')$$,
  '23514', 'group is full',
  'the eighth member is refused');

select is((select count(*)::int from group_members
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  7, 'and the refusal leaves the group at seven');

-- An existing member re-tapping the invite link must stay a no-op even at capacity.
-- /join-group upserts, and a BEFORE INSERT trigger fires before conflict detection, so
-- without an explicit exemption the seventh member would be told the group is full.
select lives_ok(
  $$insert into group_members (group_id, user_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000003')
    on conflict (group_id, user_id) do nothing$$,
  'an existing member re-joining a full group is still a no-op');

select is((select count(*)::int from group_members
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  7, 'and the group is still seven');

select * from finish();
rollback;
