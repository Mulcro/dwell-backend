-- Mock plan for the MVP. Stands in for a future YouVersion plans endpoint (design doc 3.4).
-- Only the table of contents is mocked; passage TEXT is always fetched live from the
-- real bibles/passages endpoint using passage_ref. USFM ids are already swap-ready.

insert into plan_challenges (id, title, source_type, day_count, youversion_plan_id, youversion_deep_link)
values (
  '00000000-0000-0000-0000-0000000000a1',
  'Anchored: A 7-Day Journey Through Hope',
  'youversion_plan',
  7,
  'mock-anchored-hope-7',
  'https://www.bible.com/reading-plans/mock-anchored-hope-7'
)
on conflict (id) do nothing;

insert into plan_days (plan_challenge_id, day_index, passage_ref) values
  ('00000000-0000-0000-0000-0000000000a1', 1, 'HEB.6.19'),      -- an anchor for the soul
  ('00000000-0000-0000-0000-0000000000a1', 2, 'ISA.40.31'),     -- hope renews strength
  ('00000000-0000-0000-0000-0000000000a1', 3, 'ROM.5.3-5'),     -- suffering builds hope
  ('00000000-0000-0000-0000-0000000000a1', 4, 'LAM.3.22-23'),   -- mercies new every morning
  ('00000000-0000-0000-0000-0000000000a1', 5, 'ROM.8.28'),      -- God works for good
  ('00000000-0000-0000-0000-0000000000a1', 6, '1PE.3.15'),      -- give a reason for the hope you have
  ('00000000-0000-0000-0000-0000000000a1', 7, 'REV.21.4-5')     -- hope fulfilled, all things new
on conflict (plan_challenge_id, day_index) do nothing;
