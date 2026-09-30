-- A recording must not outlive the reflection it belongs to. Storage objects cannot be
-- deleted from SQL, so the trigger records the intent and cleanup-media carries it out.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into groups (id, name, plan_challenge_id, created_by, challenge_status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Deletion Crew',
        '00000000-0000-0000-0000-0000000000a1',
        '11111111-1111-1111-1111-111111111111', 'active');
insert into group_members (group_id, user_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222');
insert into day_instances (id, group_id, day_index, date, passage_ref)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        1, current_date, 'PSA.34.18');

insert into reflections (id, user_id, day_instance_id, media_type, transcript, language,
                         media_path, media_mime, media_duration_seconds) values
  ('eeeeeeee-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'dddddddd-dddd-dddd-dddd-dddddddddddd', 'voice', 'alice speaking', 'en',
   '11111111-1111-1111-1111-111111111111/alice.m4a', 'audio/mp4', 30),
  ('eeeeeeee-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   'dddddddd-dddd-dddd-dddd-dddddddddddd', 'text', null, 'en', null, null, null);

select is((select count(*)::int from media_deletions), 0, 'nothing queued while the rows live');

-- THE ONE THAT MATTERS: closing an account must not leave the person's voice behind.
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';

select is((select count(*)::int from media_deletions), 1,
  'deleting an account queues its recording for removal');
select is((select path from media_deletions),
  '11111111-1111-1111-1111-111111111111/alice.m4a',
  'and queues the right object');

-- A text reflection has nothing to clean up.
delete from reflections where id = 'eeeeeeee-2222-2222-2222-222222222222';
select is((select count(*)::int from media_deletions), 1,
  'a text reflection queues nothing');

-- Deleting a whole group reaches its recordings through the cascade too.
insert into reflections (id, user_id, day_instance_id, media_type, transcript, language,
                         media_path, media_mime, media_duration_seconds)
values ('eeeeeeee-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
        'dddddddd-dddd-dddd-dddd-dddddddddddd', 'voice', 'bob speaking', 'en',
        '22222222-2222-2222-2222-222222222222/bob.m4a', 'audio/mp4', 20);
delete from groups where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is((select count(*)::int from media_deletions), 2,
  'deleting a group queues its recordings through the cascade');

-- The queue is service-role only; a client must not see who deleted what.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', true);
select is((select count(*)::int from media_deletions), 0,
  'the deletion queue is invisible to clients');
reset role;

select is((select schedule from cron.job where jobname = 'cleanup-media'),
  '*/15 * * * *', 'cleanup runs every 15 minutes, so removal follows closure closely');

select * from finish();
rollback;
