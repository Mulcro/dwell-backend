-- New rhythms from the Figma redesign (decided 2026-09-28).
--
-- four_per_week is the design's recommended setting: the onboarding screen before the
-- picker is built on the CBE "4+ days a week is where change happens" finding.
--
-- Postgres will not let a value added to an enum be USED in the same transaction, so
-- these are added alone and the logic that reads them lands in the next migration.

alter type day_frequency add value if not exists 'four_per_week';
alter type day_frequency add value if not exists 'custom';
