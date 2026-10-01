-- Plan cover art: the Plans screen renders a card per plan and needs something to show.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

select has_column('public', 'plan_challenges', 'image_path', 'plans carry cover art');

-- Public, unlike reflection-media: catalogue artwork is the same for everyone and is
-- served without a signed URL so the client can cache it.
select is((select public from storage.buckets where id = 'plan-images'),
  true, 'the artwork bucket is public');
select isnt((select file_size_limit from storage.buckets where id = 'plan-images'),
  null, 'and still has a size limit');

select is((select count(*)::int from plan_challenges where image_path is null),
  0, 'every seeded plan has artwork');

-- Artwork is curated: uploaded with the service role, never by a client.
insert into storage.objects (bucket_id, name) values ('plan-images', 'probe.png');

set local role anon;
-- Readable before sign-in, so an invite preview can show the plan being joined.
select is((select count(*)::int from storage.objects where bucket_id = 'plan-images'),
  1, 'artwork is readable without signing in');

select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('plan-images','sneaky.png')$$,
  '42501', null, 'but nobody can upload their own');
reset role;

select * from finish();
rollback;
