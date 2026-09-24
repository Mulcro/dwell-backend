-- Two gaps found while building the client against the design doc.
--
-- 1. The per-reflection AI response had nowhere to live. Design doc 1.1 promises
--    /submit-reflection writes "sentiment tag + translation + personalized response"
--    onto the row, but 3.1 has no column for the response. It was being smuggled into
--    translated_text under a '_response' key, which no client could be expected to find
--    and which corrupts the shape of a column that means "translations".
--
-- 2. The unlock rule was looser than the MVP Spec. The spec gates reading a day's
--    reflections on the group reaching its threshold ("if enough of the group has also
--    posted"); the policy only asked whether YOU had posted. So one member posting
--    opened everyone else's reflections before the day was earned.

alter table reflections add column ai_response text;

comment on column reflections.ai_response is
  'The personalized response written back by the generation step (design doc 1.1).';

-- Move any smuggled responses into the new column and leave translated_text meaning
-- only what its name says.
update reflections
   set ai_response = translated_text->>'_response',
       translated_text = nullif(translated_text - '_response', '{}'::jsonb)
 where translated_text ? '_response';

-- Unlock now needs BOTH halves: the day has to have been earned by the group, and you
-- have to have posted something that counts. Your own reflection stays visible to you
-- always -- you can see what you wrote while waiting for everyone else.
create or replace function public.is_reflection_unlocked(p_reflection_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from reflections r
    join day_instances di on di.id = r.day_instance_id
    join group_members gm on gm.group_id = di.group_id and gm.user_id = auth.uid()
    where r.id = p_reflection_id
      and (
        r.user_id = auth.uid()
        or (
          r.moderation_status = 'approved'
          -- the group cleared the bar for this day
          and di.status in ('threshold_met', 'complete')
          -- and the caller's own contribution counts toward it
          and exists (
            select 1 from reflections mine
            where mine.day_instance_id = r.day_instance_id
              and mine.user_id = auth.uid()
              and mine.moderation_status = 'approved'
          )
        )
      )
  );
$$;
