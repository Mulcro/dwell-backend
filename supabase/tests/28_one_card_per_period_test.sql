-- One closing summary per challenge, one weekly recap per group per week: a database
-- rule, so two ends or two overlapping cron runs cannot both land a card.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
insert into groups (id, name, plan_challenge_id, created_by, challenge_status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Once Crew',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'active');

insert into ai_insights (group_id, scope, type, content) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'group_challenge', 'end_summary', 'first');
select throws_ok(
  $$insert into ai_insights (group_id, scope, type, content) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'group_challenge', 'fallback_recap', 'second')$$,
  '23505', null, 'a challenge cannot be closed twice, whichever closing type comes second');

insert into ai_insights (group_id, scope, type, content, payload) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'group_challenge', 'weekly_recap', 'week one',
   '{"week_start": "2026-09-28"}');
select throws_ok(
  $$insert into ai_insights (group_id, scope, type, content, payload) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'group_challenge', 'weekly_recap', 'again',
     '{"week_start": "2026-09-28"}')$$,
  '23505', null, 'the same week cannot be recapped twice');
select lives_ok(
  $$insert into ai_insights (group_id, scope, type, content, payload) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'group_challenge', 'weekly_recap', 'week two',
     '{"week_start": "2026-10-05"}')$$,
  'but the next week can');

-- Pulses are per day and nudges per person; the rule must not touch them.
select lives_ok(
  $$insert into ai_insights (group_id, scope, type, content) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'group_challenge', 'nudge', 'one'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'group_challenge', 'nudge', 'two')$$,
  'other insight types are unaffected');

select * from finish();
rollback;
