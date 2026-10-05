-- KAN-22 ask 5: per-type push switches live on the member's own row.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

select is((select notification_prefs from users where id = '11111111-1111-1111-1111-111111111111'),
  '{}'::jsonb, 'every type starts on: an empty object means nothing is off');

select throws_ok(
  $$update users set notification_prefs = '{"marketing": false}' where id = '11111111-1111-1111-1111-111111111111'$$,
  '23514', null, 'an unknown switch is refused');
select throws_ok(
  $$update users set notification_prefs = '{"nudge": "off"}' where id = '11111111-1111-1111-1111-111111111111'$$,
  '23514', null, 'a switch is true or false, nothing else');
select throws_ok(
  $$update users set notification_prefs = '["nudge"]' where id = '11111111-1111-1111-1111-111111111111'$$,
  '23514', null, 'and the whole value is an object');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

select lives_ok(
  $$update users set notification_prefs = '{"nudge": false, "reply": true}' where id = '11111111-1111-1111-1111-111111111111'$$,
  'a member can set their own switches');

update users set notification_prefs = '{"reply": false}' where id = '22222222-2222-2222-2222-222222222222';

reset role;
select is((select notification_prefs from users where id = '11111111-1111-1111-1111-111111111111'),
  '{"nudge": false, "reply": true}'::jsonb, 'and they are stored as set');
select is((select notification_prefs from users where id = '22222222-2222-2222-2222-222222222222'),
  '{}'::jsonb, 'but nobody can change someone else''s');

select * from finish();
rollback;
