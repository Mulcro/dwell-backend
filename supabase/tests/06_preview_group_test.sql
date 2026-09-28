-- preview_group: the one function anon may call, powering the in-browser invite page
-- before the visitor signs in or installs the app.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');

insert into groups (id, name, plan_challenge_id, created_by, invite_token)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Morning Crew',
        '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'test-token-01');

set local role anon;

select is((select name from public.preview_group('test-token-01')),
  'Morning Crew', 'a valid invite token returns the group name');
select is((select plan_title from public.preview_group('test-token-01')),
  'When Life Gets Hard', 'and the plan title');

-- A wrong or expired token reveals nothing, and must not error either: the invite page
-- needs to render a plain "not found" rather than a stack trace.
select is((select count(*)::int from public.preview_group('no-such-token')),
  0, 'an unknown token returns no rows');

-- The RPC is a keyhole, not a door: the tables behind it stay shut to anon.
select is((select count(*)::int from groups), 0, 'anon cannot read the groups table');
select is((select count(*)::int from users), 0, 'anon cannot read profiles');

reset role;
select * from finish();
rollback;
