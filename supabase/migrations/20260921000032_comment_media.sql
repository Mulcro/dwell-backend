-- Item 43: a reply can carry what a reflection carries.
--
-- comments had a single content column, so a reply could only ever be words. The client
-- is already built for audio and images and gated on a probe for these columns.
--
-- The shape deliberately mirrors reflections, so there is nothing new to learn: a photo
-- needs words, a voice reply needs a transcript, and a photo has no duration or waveform.

alter table comments
  add column media_type media_type not null default 'text',
  add column media_path text,
  add column media_mime text,
  add column media_duration_seconds int,
  add column media_peaks smallint[],
  add column transcript text;

-- A voice reply's transcript is its visible body, so content stops being mandatory.
alter table comments alter column content drop not null;

alter table comments add constraint comment_media_matches_type check (
  (media_type = 'text' and media_path is null and content is not null
   and btrim(content) <> '')
  or (media_type = 'voice' and media_path is not null and transcript is not null
      and btrim(transcript) <> '')
  or (media_type = 'photo' and media_path is not null
      and content is not null and btrim(content) <> '')
);

alter table comments add constraint comment_duration_sane
  check (media_duration_seconds is null
         or (media_duration_seconds >= 1 and media_duration_seconds <= 120));

alter table comments add constraint comment_peaks_is_drawable check (
  media_peaks is null
  -- coalesce, because array_length of an empty array is NULL and a CHECK passes on NULL.
  or (coalesce(array_length(media_peaks, 1), 0) between 1 and 512
      and 0 <= all (media_peaks)
      and 100 >= all (media_peaks))
);

-- A reply's media lives in the same bucket as a reflection's and is readable on exactly
-- the same terms: when the parent reflection is unlocked for you. SELECT policies are
-- permissive, so this sits alongside the reflection one rather than replacing it.
create policy "read media of a reply you can see" on storage.objects
  for select to authenticated
  using (bucket_id = 'reflection-media'
    and exists (
      select 1 from comments c
      where c.media_path = storage.objects.name
        and public.is_reflection_unlocked(c.reflection_id)
    ));

-- A reply now carries images and audio, so it can no longer be a plain insert: it has to
-- pass moderation first. submit-comment is the only way in, exactly as submit-reflection
-- is for reflections.
drop policy if exists "insert own comment" on comments;
revoke insert, update, delete on comments from authenticated, anon;

-- Deleting a reply must take its media with it, like a reflection's.
create or replace function public.queue_comment_media_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.media_path is not null then
    insert into media_deletions (bucket, path)
    values ('reflection-media', old.media_path)
    on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function public.queue_comment_media_deletion() from public, anon, authenticated;

create trigger comments_queue_media_deletion
  after delete on comments
  for each row execute function public.queue_comment_media_deletion();
