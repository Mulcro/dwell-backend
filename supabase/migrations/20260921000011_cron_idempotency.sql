-- The two counter-advancing cron jobs run once a day, but a retry or a manual re-run
-- would otherwise double-count and skip a day early. These markers make both jobs
-- idempotent: each records the date it last acted on a row, and refuses to act twice.

alter table day_instances add column last_autoskip_on date;
alter table groups add column last_inactivity_check_on date;

comment on column day_instances.last_autoskip_on is
  'Date daily-cron-autoskip last incremented consecutive_below_threshold_count for this day.';
comment on column groups.last_inactivity_check_on is
  'Date daily-cron-inactivity-check last updated consecutive_silent_days for this group.';
