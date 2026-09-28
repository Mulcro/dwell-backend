-- Reading rhythm (design doc 4.1). A fixed clock is passed in so the result does not
-- depend on which day the suite happens to run.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- 2026-09-21 Mon, 09-23 Wed, 09-25 Fri, 09-26 Sat, 09-27 Sun
select is(public.day_opens_today('daily', 'UTC', '2026-09-26T12:00:00Z'), true,
  'daily opens on a Saturday');
select is(public.day_opens_today('daily', 'UTC', '2026-09-27T12:00:00Z'), true,
  'daily opens on a Sunday');

select is(public.day_opens_today('weekdays', 'UTC', '2026-09-21T12:00:00Z'), true,
  'weekdays opens on Monday');
select is(public.day_opens_today('weekdays', 'UTC', '2026-09-25T12:00:00Z'), true,
  'weekdays opens on Friday');
select is(public.day_opens_today('weekdays', 'UTC', '2026-09-26T12:00:00Z'), false,
  'weekdays rests on Saturday');
select is(public.day_opens_today('weekdays', 'UTC', '2026-09-27T12:00:00Z'), false,
  'weekdays rests on Sunday');

select is(public.day_opens_today('three_per_week', 'UTC', '2026-09-21T12:00:00Z'), true,
  'three_per_week opens Monday');
select is(public.day_opens_today('three_per_week', 'UTC', '2026-09-23T12:00:00Z'), true,
  'three_per_week opens Wednesday');
select is(public.day_opens_today('three_per_week', 'UTC', '2026-09-25T12:00:00Z'), true,
  'three_per_week opens Friday');
select is(public.day_opens_today('three_per_week', 'UTC', '2026-09-22T12:00:00Z'), false,
  'three_per_week rests Tuesday');

-- The group's own timezone decides which local day it is. At 2026-09-26 11:00 UTC it is
-- already Saturday in Auckland but still Friday in Los Angeles.
select is(public.day_opens_today('weekdays', 'Pacific/Auckland', '2026-09-25T20:00:00Z'), false,
  'a Friday evening in UTC is already Saturday in Auckland, so it rests');
select is(public.day_opens_today('weekdays', 'America/Los_Angeles', '2026-09-26T04:00:00Z'), true,
  'the same moment is still Friday in Los Angeles, so it opens');

-- four_per_week: Mon, Tue, Thu, Fri -- the design's recommended rhythm.
select is(public.day_opens_today('four_per_week', 'UTC', '2026-09-21T12:00:00Z'), true,
  'four_per_week opens Monday');
select is(public.day_opens_today('four_per_week', 'UTC', '2026-09-22T12:00:00Z'), true,
  'four_per_week opens Tuesday');
select is(public.day_opens_today('four_per_week', 'UTC', '2026-09-23T12:00:00Z'), false,
  'four_per_week rests Wednesday');
select is(public.day_opens_today('four_per_week', 'UTC', '2026-09-25T12:00:00Z'), true,
  'four_per_week opens Friday');
select is(public.day_opens_today('four_per_week', 'UTC', '2026-09-26T12:00:00Z'), false,
  'four_per_week rests at the weekend');

-- custom: whatever days the group chose.
select is(public.day_opens_today('custom', 'UTC', '2026-09-27T12:00:00Z', array[7]), true,
  'a Sunday-only group opens on Sunday');
select is(public.day_opens_today('custom', 'UTC', '2026-09-21T12:00:00Z', array[7]), false,
  'and rests every other day');

-- An unusable timezone must not stall a group forever.
select is(public.day_opens_today('weekdays', 'Not/AZone', '2026-09-21T12:00:00Z'), true,
  'a bad timezone falls back to UTC rather than blocking');

-- ---------------------------------------------------------- advancement honours it
insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');

insert into groups (id, name, plan_challenge_id, created_by, challenge_status, frequency, timezone) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Weekday Crew', '00000000-0000-0000-0000-0000000000a1',
   '11111111-1111-1111-1111-111111111111', 'active', 'weekdays', 'UTC'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Daily Crew', '00000000-0000-0000-0000-0000000000a1',
   '11111111-1111-1111-1111-111111111111', 'active', 'daily', 'UTC');

insert into day_instances (group_id, day_index, date, passage_ref, opened_at, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, '2026-09-24', 'PSA.34.18', '2026-09-25T09:00:00Z', 'threshold_met'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, '2026-09-24', 'PSA.34.18', '2026-09-25T09:00:00Z', 'threshold_met');

-- Saturday: the weekday group rests, the daily group moves on.
select public.open_ready_next_days('2026-09-26T10:00:00Z');

select is((select count(*)::int from day_instances where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'no new day opens for a weekday group on Saturday');
select is((select status::text from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and day_index = 1),
  'threshold_met',
  'the cleared day stays threshold_met over the weekend, so Monday can still find it');
select is((select count(*)::int from day_instances where group_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  2, 'a daily group advances on Saturday');

-- Monday: the weekend is over and the rhythm resumes.
select public.open_ready_next_days('2026-09-28T10:00:00Z');

select is((select passage_ref from day_instances
           where group_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and day_index = 2),
  'ISA.43.2', 'the weekday group picks up again on Monday');

select * from finish();
rollback;
