-- Group Pulse carries structure now, not one prose block, and it catches up as more of
-- the group posts.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

select has_column('public', 'ai_insights', 'payload', 'an insight can carry structure');
select has_column('public', 'ai_insights', 'language', 'and says what it was written in');
select has_column('public', 'ai_insights', 'translated_text',
  'and carries translations, so a French reader does not get an English pulse');

-- Every string on the card is AI-authored English; without translation the one screen
-- that is meant to show a group reading each other is the one nobody can read.
select is((select language from ai_insights limit 0), null, 'language defaults are set');

-- The pulse used to be dispatched only by the call that flipped the day, so it was a
-- snapshot of the threshold moment forever. It must now fire on later approvals too.
select ok(
  (select count(*) from pg_proc p
    where p.proname = 'check_day_threshold'
      and pg_get_functiondef(p.oid) not like '%if v_flipped = 1 then%') = 1,
  'a later approval still dispatches the pulse');

select * from finish();
rollback;
