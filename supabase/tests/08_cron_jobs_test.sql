-- Scheduled jobs (design doc 5.2). Nothing in the daily loop runs if these are missing,
-- and a wrong schedule fails silently, so assert the wiring explicitly.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

select is((select schedule from cron.job where jobname = 'open-ready-next-days'),
  '*/15 * * * *', 'advancement runs every 15 min, so a day opens promptly at its 24h mark');
select is((select schedule from cron.job where jobname = 'daily-cron-nudge'),
  '*/15 * * * *', 'nudges run every 15 min to respect per-user local timezones');
select is((select schedule from cron.job where jobname = 'daily-cron-autoskip'),
  '15 0 * * *', 'auto-skip runs daily at 00:15 UTC');
select is((select schedule from cron.job where jobname = 'daily-cron-inactivity-check'),
  '30 0 * * *', 'the inactivity sweep runs daily at 00:30 UTC');
select is((select schedule from cron.job where jobname = 'weekly-cron-leaderboard'),
  '0 0 * * 1', 'the leaderboard runs Monday 00:00 UTC');

-- Re-running the migration must not leave duplicate jobs behind.
select is((select count(*)::int from cron.job
           where jobname in ('open-ready-next-days', 'daily-cron-nudge', 'daily-cron-autoskip',
                             'daily-cron-inactivity-check', 'weekly-cron-leaderboard')),
  5, 'each job is scheduled exactly once');

select * from finish();
rollback;
