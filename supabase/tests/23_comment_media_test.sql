-- Item 43: a reply carries what a reflection carries. The shape mirrors reflections, so
-- these assertions mirror theirs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', '{"name":"Poster"}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', '{"name":"Replier"}'::jsonb);
insert into groups (id, name, plan_challenge_id, created_by, challenge_status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Replies',
        '00000000-0000-0000-0000-0000000000a1',
        '11111111-1111-1111-1111-111111111111', 'active');
insert into group_members (group_id, user_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222');
insert into day_instances (id, group_id, day_index, date, passage_ref)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'PSA.34.18');
insert into reflections (id, user_id, day_instance_id, media_type, content, language,
                         moderation_status)
values ('eeeeeeee-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
        'dddddddd-dddd-dddd-dddd-dddddddddddd', 'text', 'the parent', 'en', 'approved');

select has_column('public', 'comments', 'media_path', 'a reply can carry media');
select has_column('public', 'comments', 'media_peaks', 'and a waveform to draw it with');
select has_column('public', 'comments', 'transcript', 'and a transcript for a voice reply');

-- A reply is no longer a plain insert: it carries images and audio now, so it has to pass
-- moderation, and submit-comment is the only way in.
select ok(
  not has_table_privilege('authenticated', 'public.comments', 'INSERT'),
  'clients cannot insert a reply directly any more');
select ok(
  has_table_privilege('authenticated', 'public.comments', 'SELECT'),
  'but can still read the ones they are allowed to see');

-- Same rules as a reflection, so there is nothing new to learn.
select throws_ok(
  $$insert into comments (reflection_id, user_id, media_type, media_path, media_mime)
    values ('eeeeeeee-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
            'photo', '22222222/a.jpg', 'image/jpeg')$$,
  '23514', null, 'a photo reply with nothing said about it is refused');

select throws_ok(
  $$insert into comments (reflection_id, user_id, media_type, media_path, media_mime,
                          media_duration_seconds)
    values ('eeeeeeee-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
            'voice', '22222222/a.m4a', 'audio/mp4', 10)$$,
  '23514', null, 'a voice reply with no transcript is refused');

select lives_ok(
  $$insert into comments (reflection_id, user_id, media_type, content, media_path,
                          media_mime, media_peaks)
    values ('eeeeeeee-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
            'photo', 'what a view', '22222222/b.jpg', 'image/jpeg', null)$$,
  'a photo reply with words is accepted');

-- Deleting a reply must take its upload with it, like a reflection's.
delete from comments where user_id = '22222222-2222-2222-2222-222222222222';
select is((select count(*)::int from media_deletions where path = '22222222/b.jpg'),
  1, 'and deleting a reply queues its upload for removal');

-- Item 44: a reply reaches each reader in their own language, like a reflection.
select has_column('public', 'comments', 'language', 'a reply records what it was written in');
select has_column('public', 'comments', 'translated_text',
  'and carries translations keyed by the language translated INTO');

select * from finish();
rollback;
