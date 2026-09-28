-- Plan catalogue from the Figma redesign (decided 2026-09-28): the two plans the
-- onboarding screens actually name, replacing the placeholder "Anchored" seed.
--
-- The first keeps the original UUID rather than taking a new one. Nothing user-facing
-- depends on the id, and reusing it means the seed script, fixtures and any group
-- already created against it keep resolving instead of pointing at a deleted plan.

update plan_challenges
   set title = 'When Life Gets Hard',
       youversion_plan_id = 'mock-when-life-gets-hard-7',
       youversion_deep_link = 'https://www.bible.com/reading-plans/mock-when-life-gets-hard-7'
 where id = '00000000-0000-0000-0000-0000000000a1';

delete from plan_days where plan_challenge_id = '00000000-0000-0000-0000-0000000000a1';

insert into plan_days (plan_challenge_id, day_index, passage_ref) values
  ('00000000-0000-0000-0000-0000000000a1', 1, 'PSA.34.18'),    -- close to the brokenhearted
  ('00000000-0000-0000-0000-0000000000a1', 2, 'ISA.43.2'),     -- when you pass through the waters
  ('00000000-0000-0000-0000-0000000000a1', 3, 'ROM.8.28'),     -- works together for good
  ('00000000-0000-0000-0000-0000000000a1', 4, '2CO.4.16-18'),  -- light and momentary affliction
  ('00000000-0000-0000-0000-0000000000a1', 5, 'PSA.23.4'),     -- the valley of the shadow
  ('00000000-0000-0000-0000-0000000000a1', 6, 'JAS.1.2-4'),    -- trials produce steadfastness
  ('00000000-0000-0000-0000-0000000000a1', 7, 'REV.21.4');     -- every tear wiped away

insert into plan_challenges (id, title, source_type, day_count, youversion_plan_id, youversion_deep_link)
values (
  '00000000-0000-0000-0000-0000000000a2',
  'The Psalms: A Roadmap to Resilience',
  'youversion_plan',
  7,
  'mock-psalms-resilience-7',
  'https://www.bible.com/reading-plans/mock-psalms-resilience-7'
)
on conflict (id) do nothing;

-- Whole chapters here: a psalm is the unit, and chapter ids are known-good against the
-- passages endpoint.
insert into plan_days (plan_challenge_id, day_index, passage_ref) values
  ('00000000-0000-0000-0000-0000000000a2', 1, 'PSA.1'),        -- the tree by streams of water
  ('00000000-0000-0000-0000-0000000000a2', 2, 'PSA.13'),       -- how long, O Lord?
  ('00000000-0000-0000-0000-0000000000a2', 3, 'PSA.27'),       -- the Lord is my light
  ('00000000-0000-0000-0000-0000000000a2', 4, 'PSA.42'),       -- as the deer pants
  ('00000000-0000-0000-0000-0000000000a2', 5, 'PSA.46'),       -- a very present help
  ('00000000-0000-0000-0000-0000000000a2', 6, 'PSA.73'),       -- nevertheless I am with you
  ('00000000-0000-0000-0000-0000000000a2', 7, 'PSA.121')       -- I lift up my eyes
on conflict (plan_challenge_id, day_index) do nothing;
