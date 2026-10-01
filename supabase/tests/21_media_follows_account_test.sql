-- A deleted account must take its recordings with it, whichever route deleted it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id, raw_user_meta_data)
values ('99999999-9999-9999-9999-999999999999', '{"name":"Leaver"}'::jsonb);

-- Two objects: one that a reflection points at, and one orphan whose submit never
-- completed. The orphan is the case /delete-account was added for and the reflections
-- trigger cannot see, because no row was ever written for it.
insert into storage.objects (bucket_id, name) values
  ('reflection-media', '99999999-9999-9999-9999-999999999999/attached.m4a'),
  ('reflection-media', '99999999-9999-9999-9999-999999999999/orphan.m4a');

-- Someone else's recording, which must survive.
insert into auth.users (id, raw_user_meta_data)
values ('12121212-1212-1212-1212-121212121212', '{"name":"Stayer"}'::jsonb);
insert into storage.objects (bucket_id, name)
values ('reflection-media', '12121212-1212-1212-1212-121212121212/keep.m4a');

select is((select count(*)::int from media_deletions), 0, 'nothing is queued to start');

-- Deleting the AUTH user, as the dashboard and the admin API both do. public.users goes
-- by cascade, and the cascade has to carry the sweep with it.
delete from auth.users where id = '99999999-9999-9999-9999-999999999999';

select is((select count(*)::int from media_deletions), 2,
  'both recordings are queued when the account goes');
select ok(
  exists(select 1 from media_deletions
         where path = '99999999-9999-9999-9999-999999999999/orphan.m4a'),
  'including an upload no reflection ever referenced');
select ok(
  exists(select 1 from media_deletions
         where path = '99999999-9999-9999-9999-999999999999/attached.m4a'),
  'and the one a reflection did reference');

-- The sweep is scoped by folder, so it must not reach into anyone else's.
select ok(
  not exists(select 1 from media_deletions
             where path like '12121212-1212-1212-1212-121212121212/%'),
  'and nobody else loses a recording');

select * from finish();
rollback;
