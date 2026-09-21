-- Extensions the scheduled jobs and the in-database HTTP dispatch depend on.
--
-- Design doc 5.4 has these enabled by hand in the dashboard. Doing it in a migration
-- instead keeps local, CI and production identical, is idempotent, and lets the cron
-- wiring actually be tested rather than skipped.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
