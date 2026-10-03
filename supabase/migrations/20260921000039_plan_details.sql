-- Item 50: what the Plans screens render per plan -- a description, a key verse with
-- its reference, and a theme line per day -- plus the three plans the design defines.
--
-- The two earlier plans stay exactly as they are: the demo seed, the fixtures and live
-- groups all point at them, and the design wrote no copy for them. The new plans take
-- fixed ids in the same series so scripts and tests can name them.

alter table plan_challenges
  add column description text,
  add column key_verse text,
  add column key_verse_ref text;

comment on column plan_challenges.description is
  'One or two sentences for the plan detail screen.';
comment on column plan_challenges.key_verse is
  'Verse body without quote marks; the client adds them.';
comment on column plan_challenges.key_verse_ref is
  'Human-readable reference for key_verse, such as Psalm 46:10.';

alter table plan_days add column title text;

comment on column plan_days.title is
  'The day''s theme line, shown beside the passage in the day list.';

insert into plan_challenges
  (id, title, source_type, day_count, description, key_verse, key_verse_ref, image_path)
values
  ('00000000-0000-0000-0000-0000000000a3', 'Be Still', 'custom', 3,
   'Three days to slow down, quiet the noise, and let God speak first. A good place to start if your group is new to daily quiet time.',
   'Be still and know that I am God.', 'Psalm 46:10', 'be-still.png'),
  ('00000000-0000-0000-0000-0000000000a4', 'Better Together', 'custom', 7,
   'Seven days on why faith was never meant to be done alone, and what it looks like to show up for each other.',
   'A cord of three strands is not quickly broken.', 'Ecclesiastes 4:12', 'better-together.png'),
  ('00000000-0000-0000-0000-0000000000a5', 'Abide', 'custom', 14,
   'Two weeks of learning to rely on God, one quiet time at a time. For groups ready to make time with God part of every day.',
   'The one who remains in Me, and I in him, will bear much fruit.', 'John 15:5', 'abide.png')
on conflict (id) do nothing;

insert into plan_days (plan_challenge_id, day_index, title, passage_ref) values
  ('00000000-0000-0000-0000-0000000000a3', 1, 'Stop',   'PSA.46.1-11'),
  ('00000000-0000-0000-0000-0000000000a3', 2, 'Listen', '1KI.19.9-13'),
  ('00000000-0000-0000-0000-0000000000a3', 3, 'Trust',  'ISA.26.3-4'),

  ('00000000-0000-0000-0000-0000000000a4', 1, 'Two are better than one', 'ECC.4.9-12'),
  ('00000000-0000-0000-0000-0000000000a4', 2, 'Devoted together',        'ACT.2.42-47'),
  ('00000000-0000-0000-0000-0000000000a4', 3, 'Carry each other',        'GAL.6.1-5'),
  ('00000000-0000-0000-0000-0000000000a4', 4, 'Spur one another on',     'HEB.10.23-25'),
  ('00000000-0000-0000-0000-0000000000a4', 5, 'Love without pretending', 'ROM.12.9-16'),
  ('00000000-0000-0000-0000-0000000000a4', 6, 'Build each other up',     '1TH.5.11-18'),
  ('00000000-0000-0000-0000-0000000000a4', 7, 'Known by our love',       'JHN.13.34-35'),

  ('00000000-0000-0000-0000-0000000000a5',  1, 'Remain in the vine',        'JHN.15.1-8'),
  ('00000000-0000-0000-0000-0000000000a5',  2, 'A solitary place',          'MRK.1.35-39'),
  ('00000000-0000-0000-0000-0000000000a5',  3, 'Thirsty for God',           'PSA.63.1-8'),
  ('00000000-0000-0000-0000-0000000000a5',  4, 'New every morning',         'LAM.3.22-26'),
  ('00000000-0000-0000-0000-0000000000a5',  5, 'Pray like this',            'MAT.6.5-13'),
  ('00000000-0000-0000-0000-0000000000a5',  6, 'The Lord is my shepherd',   'PSA.23'),
  ('00000000-0000-0000-0000-0000000000a5',  7, 'Strength for the weary',    'ISA.40.28-31'),
  ('00000000-0000-0000-0000-0000000000a5',  8, 'Don''t be anxious',         'PHP.4.6-7'),
  ('00000000-0000-0000-0000-0000000000a5',  9, 'Come to Me',                'MAT.11.28-30'),
  ('00000000-0000-0000-0000-0000000000a5', 10, 'Help from the hills',       'PSA.121'),
  ('00000000-0000-0000-0000-0000000000a5', 11, 'Grace that is enough',      '2CO.12.9-10'),
  ('00000000-0000-0000-0000-0000000000a5', 12, 'Trust with all your heart', 'PRO.3.5-6'),
  ('00000000-0000-0000-0000-0000000000a5', 13, 'My soul waits',             'PSA.62.1-8'),
  ('00000000-0000-0000-0000-0000000000a5', 14, 'Nothing can separate us',   'ROM.8.31-39')
on conflict (plan_challenge_id, day_index) do nothing;
