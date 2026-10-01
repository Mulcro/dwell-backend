-- Deleting an account must take its recordings with it, whoever does the deleting.
--
-- /delete-account already sweeps the caller's folder, and that works. But it is only one
-- of the ways an account disappears: the Supabase dashboard, the admin API and plain SQL
-- all bypass it, and each of those leaves the audio sitting in the bucket with nothing
-- left to point at it. Putting the sweep on the table makes the guarantee independent of
-- the route taken -- including routes that do not exist yet.
--
-- public.users is removed by cascade from auth.users, and a cascade fires row triggers,
-- so this covers deletion at the auth layer too.

create or replace function public.queue_user_media_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Everything under the user's folder, not just what a reflection referenced: an upload
  -- whose submit never completed is exactly the case that leaves audio behind, and the
  -- trigger on reflections cannot see it because no row was ever written.
  insert into public.media_deletions (path)
  select o.name
  from storage.objects o
  where o.bucket_id = 'reflection-media'
    and (storage.foldername(o.name))[1] = old.id::text
  on conflict (path) do nothing;

  return old;
end;
$$;

revoke all on function public.queue_user_media_deletion() from public, anon, authenticated;

create trigger on_user_deleted_queue_media
  after delete on public.users
  for each row execute function public.queue_user_media_deletion();

-- One-time sweep: anything already in the bucket whose owner is gone. Harmless when
-- there is nothing to find, and the only way to catch what earlier deletions left.
insert into public.media_deletions (path)
select o.name
from storage.objects o
where o.bucket_id = 'reflection-media'
  and not exists (
    select 1 from public.users u
    where u.id::text = (storage.foldername(o.name))[1]
  )
on conflict (path) do nothing;
