-- Photo reflections and chosen profile pictures. Both are moderated before anyone else
-- sees them; these assertions cover the parts the database is responsible for.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select ok('photo' = any (enum_range(null::media_type)::text[]),
  'a reflection can be a photo');

-- A photo is a reflection, so it lives in the same bucket and inherits the unlock rule
-- already written for audio rather than needing a second copy of it.
select ok(
  (select allowed_mime_types from storage.buckets where id = 'reflection-media')
    @> array['image/jpeg', 'image/png'],
  'reflection media accepts images as well as audio');

-- Avatars are separate because the read rule differs: a face shows on a sealed day,
-- before anything is unlocked.
select is((select public from storage.buckets where id = 'avatars'),
  false, 'the avatar bucket is private');
select ok(
  (select count(*) from pg_policies
    where schemaname = 'storage' and policyname = 'see a group-mate''s avatar') = 1,
  'and is readable only by you and your group-mates');

-- Neither avatar column is writable by its owner. Without this, anyone could point
-- avatar_url at any image on the internet and show it to their group unchecked.
select ok(
  not has_column_privilege('authenticated', 'public.users', 'avatar_url', 'UPDATE'),
  'nobody can set their own avatar_url directly');
select ok(
  not has_column_privilege('authenticated', 'public.users', 'avatar_path', 'UPDATE'),
  'nor avatar_path -- set-avatar is the only way in, after moderation');
select ok(
  has_column_privilege('authenticated', 'public.users', 'name', 'UPDATE'),
  'but the rest of the profile is still editable');

-- The queue serves two buckets now, so a path alone no longer identifies a row.
select set_eq(
  $$select a.attname::text from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = 'public.media_deletions'::regclass and c.contype = 'p'$$,
  $$values ('bucket'), ('path')$$,
  'the deletion queue is keyed by bucket and path');

select * from finish();
rollback;
