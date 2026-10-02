-- Images: photo reflections, and profile pictures people choose themselves.
--
-- Both are moderated before anyone else can see them. The moderation endpoint we already
-- call for every reflection is multimodal, so an image is checked the same way text is,
-- and a failure destroys the file rather than merely hiding it.

-- A photo is a reflection like any other, so it lives in the same bucket and inherits
-- the unlock rule already written for audio -- you see a group-mate's photo exactly when
-- you would have seen their words. A second bucket would mean a second copy of that rule.
update storage.buckets
set allowed_mime_types = array[
      'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/wav',
      'image/jpeg', 'image/png', 'image/webp', 'image/heic'
    ]
where id = 'reflection-media';

alter type media_type add value if not exists 'photo';

-- Avatars need their own bucket because the read rule is different: a group-mate's face
-- shows on the sealed day, before anything is unlocked, so it cannot sit behind the
-- reflection lock.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "upload your own avatar" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text);

create policy "replace your own avatar" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "remove your own avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Readable by you and by anyone you share a group with -- the same reach the profile row
-- itself already has, so a face is no more exposed than the name beside it.
create policy "see a group-mate's avatar" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.shares_group_with(((storage.foldername(name))[1])::uuid)
    ));

-- Kept apart from avatar_url, which holds whatever the identity provider gave us. One
-- column per meaning: a path into the avatars bucket, and an external URL. The client
-- prefers the path when it is set.
alter table users add column avatar_path text;

comment on column users.avatar_path is
  'Object key in the private avatars bucket. Set only by set-avatar, after moderation.';

-- Neither avatar column is writable by its owner: both are set by the server, one from
-- provider metadata and one by set-avatar once the image has passed moderation. Without
-- this, anyone could point avatar_url at any image on the internet and show it to their
-- group with nothing having checked it.
revoke update on users from authenticated;
grant update (name, preferred_language, timezone, push_token) on users to authenticated;

-- The deletion queue now serves two buckets, so it has to say which.
alter table media_deletions add column bucket text not null default 'reflection-media';

alter table media_deletions drop constraint media_deletions_pkey;
alter table media_deletions add primary key (bucket, path);

-- The reflections trigger predates the queue having a bucket, so its ON CONFLICT no
-- longer matches the key. A reflection's media always lives in reflection-media, which
-- is the column default, but naming it is clearer than relying on that.
create or replace function public.queue_media_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.media_path is not null then
    -- on conflict: the same path can be queued twice if a retry re-deletes a row.
    insert into media_deletions (bucket, path)
    values ('reflection-media', old.media_path)
    on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function public.queue_media_deletion() from public, anon, authenticated;

-- The sweep on account deletion predates the avatars bucket, so it only knew about one.
-- A face left behind is exactly the kind of thing deleting an account is meant to remove.
create or replace function public.queue_user_media_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.media_deletions (bucket, path)
  select o.bucket_id, o.name
  from storage.objects o
  where o.bucket_id in ('reflection-media', 'avatars')
    and (storage.foldername(o.name))[1] = old.id::text
  on conflict (bucket, path) do nothing;

  return old;
end;
$$;

revoke all on function public.queue_user_media_deletion() from public, anon, authenticated;
