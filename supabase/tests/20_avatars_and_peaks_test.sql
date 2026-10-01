-- Item 42: everyone rendered as a monogram because users had no avatar column, while
-- the picture sat unread in the provider metadata the trigger already looks at.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select has_column('public', 'users', 'avatar_url', 'profiles carry a picture');

-- Google puts it in avatar_url ...
insert into auth.users (id, raw_user_meta_data)
values ('44444444-4444-4444-4444-444444444444',
        '{"name":"Gee","avatar_url":"https://example.test/g.jpg"}'::jsonb);
select is((select avatar_url from public.users where id = '44444444-4444-4444-4444-444444444444'),
  'https://example.test/g.jpg', 'a Google picture is picked up at signup');

-- ... Apple and others put it in picture. Both are the same metadata the trigger already
-- reads for name, so neither needs a second round trip.
insert into auth.users (id, raw_user_meta_data)
values ('55555555-5555-5555-5555-555555555555',
        '{"name":"Pea","picture":"https://example.test/p.jpg"}'::jsonb);
select is((select avatar_url from public.users where id = '55555555-5555-5555-5555-555555555555'),
  'https://example.test/p.jpg', 'and so is a picture under the other key');

-- An email signup has neither, and must still get a profile rather than an error.
insert into auth.users (id, raw_user_meta_data) values
  ('66666666-6666-6666-6666-666666666666', '{}'::jsonb);
select is((select avatar_url from public.users where id = '66666666-6666-6666-6666-666666666666'),
  null, 'someone with no picture simply has none');

-- Waveform: drawn by the feed without downloading the audio first.
insert into groups (id, name, plan_challenge_id, created_by)
values ('77777777-7777-7777-7777-777777777777', 'Peaks',
        '00000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444');
insert into day_instances (id, group_id, day_index, date, passage_ref)
values ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777',
        1, current_date, 'PSA.34.18');

select lives_ok(
  $$insert into reflections (user_id, day_instance_id, media_type, transcript, language, media_peaks)
    values ('44444444-4444-4444-4444-444444444444', '88888888-8888-8888-8888-888888888888',
            'voice', 'hi', 'en', array[0,50,100]::smallint[])$$,
  'a normalized waveform is accepted');

select throws_ok(
  $$insert into reflections (user_id, day_instance_id, media_type, transcript, language, media_peaks)
    values ('55555555-5555-5555-5555-555555555555', '88888888-8888-8888-8888-888888888888',
            'voice', 'hi', 'en', array[0,101]::smallint[])$$,
  '23514', null, 'but an out-of-range sample is refused');

select throws_ok(
  $$insert into reflections (user_id, day_instance_id, media_type, transcript, language, media_peaks)
    values ('66666666-6666-6666-6666-666666666666', '88888888-8888-8888-8888-888888888888',
            'voice', 'hi', 'en', '{}'::smallint[])$$,
  '23514', null, 'and so is an empty one');

select * from finish();
rollback;
