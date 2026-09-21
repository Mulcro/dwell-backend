-- handle_new_auth_user: a profile row appears the moment Auth creates the user,
-- whatever provider issued the session.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111', '{"name": "Alice"}'::jsonb);

select is(
  (select name from public.users where id = '11111111-1111-1111-1111-111111111111'),
  'Alice', 'name is taken from the provider metadata'
);
select is(
  (select preferred_language from public.users where id = '11111111-1111-1111-1111-111111111111'),
  'en', 'preferred_language seeds to the en placeholder'
);
select is(
  (select timezone from public.users where id = '11111111-1111-1111-1111-111111111111'),
  'UTC', 'timezone seeds to the UTC placeholder'
);

-- A provider that sends no name must still produce a usable profile.
insert into auth.users (id, raw_user_meta_data)
values ('22222222-2222-2222-2222-222222222222', '{}'::jsonb);

select is(
  (select name from public.users where id = '22222222-2222-2222-2222-222222222222'),
  'Friend', 'missing provider name falls back to Friend'
);

-- Deleting the auth user must not strand an orphan profile.
delete from auth.users where id = '22222222-2222-2222-2222-222222222222';
select is(
  (select count(*)::int from public.users where id = '22222222-2222-2222-2222-222222222222'),
  0, 'profile is removed with the auth user'
);

select * from finish();
rollback;
