-- Schema shape: every table, enum and guard rail the rest of the system assumes.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

select has_table('public', 'users', 'users exists');
select has_table('public', 'plan_challenges', 'plan_challenges exists');
select has_table('public', 'plan_days', 'plan_days exists');
select has_table('public', 'groups', 'groups exists');
select has_table('public', 'group_members', 'group_members exists');
select has_table('public', 'day_instances', 'day_instances exists');
select has_table('public', 'reflections', 'reflections exists');
select has_table('public', 'comments', 'comments exists');
select has_table('public', 'reactions', 'reactions exists');
select has_table('public', 'ai_insights', 'ai_insights exists');
select has_table('public', 'leaderboard_entries', 'leaderboard_entries exists');

-- PHASE1 #3: the inactivity prompt needs its own insight type and group-level state.
select enum_has_labels(
  'public', 'insight_type',
  array['group_pulse', 'nudge', 'end_summary', 'fallback_recap', 'inactivity_prompt'],
  'insight_type carries inactivity_prompt'
);
select has_column('public', 'groups', 'consecutive_silent_days', 'groups tracks silent days');
select has_column('public', 'groups', 'prompt_pending', 'groups tracks a pending prompt');

-- One reflection per user per day, enforced in the database rather than by the function.
select col_is_unique(
  'public', 'reflections', array['user_id', 'day_instance_id'],
  'one reflection per user per day'
);

-- moderation_status is free text in the design doc; constrain it so a typo cannot
-- silently create a status that counts toward nothing and blocks forever.
select col_has_check('public', 'reflections', 'moderation_status',
  'moderation_status is constrained');

select col_is_unique('public', 'groups', 'invite_token', 'invite tokens are unique');

select * from finish();
rollback;
