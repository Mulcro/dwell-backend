-- Audio reflections: the recording itself, not just its transcript.
--
-- The MVP spec deliberately stored only the on-device transcript, "removing audio
-- storage and server-side transcription entirely". Hearing someone is the point, so the
-- media comes back -- but as an ADDITIONAL artifact on the existing pipeline, not a
-- replacement. The transcript stays required, because it is what moderation reads.

-- Private bucket. A public bucket with unguessable names is not access control, and
-- these recordings are the most private thing in the product.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reflection-media',
  'reflection-media',
  false,
  15728640,  -- 15 MB; ~2 minutes of AAC with generous headroom
  array['audio/mp4', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/wav']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

alter table reflections
  add column media_path text,
  add column media_mime text,
  add column media_duration_seconds int check (media_duration_seconds between 1 and 120);

comment on column reflections.media_path is
  'Object key in the reflection-media bucket. Shaped {user_id}/{uuid}.{ext}.';

-- A text reflection has nothing to play, and voice without a transcript could not be
-- moderated, translated or summarised -- the whole AI pipeline reads the transcript.
alter table reflections add constraint media_matches_type check (
  (media_type = 'text' and media_path is null)
  or (media_type <> 'text' and (media_path is null or transcript is not null))
);

-- One object per reflection, and one reflection per object.
create unique index reflections_media_path_key on reflections (media_path)
  where media_path is not null;

-- ---------------------------------------------------------------- storage access
--
-- Upload happens BEFORE the reflection row exists -- /submit-reflection creates that --
-- so an insert policy cannot refer to a reflection that is not there yet. The path is
-- therefore keyed by uploader, and writing is confined to your own folder.

create policy "upload into your own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'reflection-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Your own uploads stay readable: you need them before the reflection exists, and after.
create policy "read your own uploads" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reflection-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Everyone else reads on exactly the same terms as the reflection itself. Reusing
-- is_reflection_unlocked rather than restating the rule keeps one definition across
-- reflections, comments, reactions and now media -- four places that must never drift.
create policy "read media of an unlocked reflection" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reflection-media'
    and exists (
      select 1 from reflections r
      where r.media_path = storage.objects.name
        and public.is_reflection_unlocked(r.id)
    )
  );

-- Replacing or discarding your own upload before it is attached.
create policy "manage your own uploads" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'reflection-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
