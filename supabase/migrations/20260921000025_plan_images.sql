-- Plan cover art. The Plans screen renders a card per plan and had nothing to show:
-- plan_challenges carried a title and a day count but no image.
--
-- The object key is stored rather than a full URL, so the same row works against local
-- and hosted projects; the client composes the URL with getPublicUrl().

alter table plan_challenges add column image_path text;

comment on column plan_challenges.image_path is
  'Object key in the public plan-images bucket. Compose with storage getPublicUrl().';

-- Public, unlike reflection-media: this is catalogue artwork, it is the same for
-- everyone, and serving it without a signed URL lets the client cache it normally.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plan-images', 'plan-images', true, 5242880,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Readable by anyone, including before sign-in, so an invite preview can show the plan.
create policy "plan art is public" on storage.objects
  for select using (bucket_id = 'plan-images');

-- No insert/update/delete policy: artwork is curated, uploaded with the service role.

update plan_challenges set image_path = 'when-life-gets-hard.png'
  where id = '00000000-0000-0000-0000-0000000000a1';
update plan_challenges set image_path = 'psalms-resilience.png'
  where id = '00000000-0000-0000-0000-0000000000a2';
