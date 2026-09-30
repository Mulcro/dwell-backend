-- Storage access for reflection audio. This is the policy most likely to leak private
-- content if it is wrong, so it is tested before anything is built on top of it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

select is((select public from storage.buckets where id = 'reflection-media'),
  false, 'the media bucket is private');
select isnt((select file_size_limit from storage.buckets where id = 'reflection-media'),
  null, 'and has a size limit');

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),  -- alice
  ('22222222-2222-2222-2222-222222222222'),  -- bob
  ('33333333-3333-3333-3333-333333333333');  -- carol, not a member

insert into groups (id, name, plan_challenge_id, created_by, challenge_status, catch_up_threshold_pct)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Media Crew',
        '00000000-0000-0000-0000-0000000000a1',
        '11111111-1111-1111-1111-111111111111', 'active', 100);

insert into group_members (group_id, user_id, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now() - interval '2 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', now() - interval '2 days');

insert into day_instances (id, group_id, day_index, date, passage_ref, opened_at)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'PSA.34.18', now() - interval '1 hour');

-- Bob has recorded and posted; alice has not posted at all.
insert into reflections (id, user_id, day_instance_id, media_type, transcript, language,
                         media_path, media_mime, media_duration_seconds, moderation_status)
values ('eeeeeeee-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
        'dddddddd-dddd-dddd-dddd-dddddddddddd', 'voice', 'bob speaking', 'en',
        '22222222-2222-2222-2222-222222222222/bob-clip.m4a', 'audio/mp4', 45, 'approved');

insert into storage.objects (bucket_id, name, owner_id)
values ('reflection-media', '22222222-2222-2222-2222-222222222222/bob-clip.m4a',
        '22222222-2222-2222-2222-222222222222');

-- ------------------------------------------------------------ alice, has not posted
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

-- THE ONE THAT MATTERS: the day is not unlocked for her, so the recording is not hers
-- to hear. A transcript she cannot read must not arrive as audio she can play.
select is((select count(*)::int from storage.objects), 0,
  'a group-mate recording is inaudible until the day is unlocked');

select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('reflection-media','22222222-2222-2222-2222-222222222222/forged.m4a')$$,
  '42501', null,
  'you cannot upload into someone else''s folder');

select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('reflection-media','11111111-1111-1111-1111-111111111111/alice-clip.m4a')$$,
  'but you can upload into your own');

select is((select count(*)::int from storage.objects), 1,
  'and read back your own upload before any reflection exists');

-- --------------------------------------------- alice posts: the day clears at 2 of 2
reset role;
insert into reflections (id, user_id, day_instance_id, media_type, transcript, language,
                         media_path, media_mime, media_duration_seconds)
values ('eeeeeeee-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
        'dddddddd-dddd-dddd-dddd-dddddddddddd', 'voice', 'alice speaking', 'en',
        '11111111-1111-1111-1111-111111111111/alice-clip.m4a', 'audio/mp4', 30);
update reflections set moderation_status = 'approved'
  where id = 'eeeeeeee-1111-1111-1111-111111111111';

select is((select status::text from day_instances where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  'threshold_met', 'the day clears');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

select is((select count(*)::int from storage.objects), 2,
  'now she can hear bob as well as herself');

-- ------------------------------------------------------- carol, not in the group
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333"}', true);
select is((select count(*)::int from storage.objects), 0,
  'a stranger hears nothing, however the day stands');

-- ------------------------------------- a flagged recording stays silent for everyone
reset role;
update reflections set moderation_status = 'flagged'
  where id = 'eeeeeeee-2222-2222-2222-222222222222';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
select is((select count(*)::int from storage.objects
           where name = '22222222-2222-2222-2222-222222222222/bob-clip.m4a'), 0,
  'flagged audio is withdrawn even from a day that is already unlocked');

reset role;
select is((select count(*)::int from reflections
           where media_type = 'text' and media_path is not null), 0,
  'a text reflection never carries media');

select * from finish();
rollback;
