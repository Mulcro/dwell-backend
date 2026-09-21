-- PHASE1 #5: Realtime publication. The client subscribes to these two tables only.
-- reflections is deliberately NOT published: postgres_changes cannot redact columns,
-- so the content-free "X of Y posted" signal rides on day_instances.participation_count.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'day_instances'
  ) then
    alter publication supabase_realtime add table public.day_instances;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ai_insights'
  ) then
    alter publication supabase_realtime add table public.ai_insights;
  end if;
end
$$;

-- Scheduled jobs (design doc 5.2). pg_cron and pg_net are enabled by hand in the
-- dashboard (5.4 step 3), so this block skips cleanly when they are not on yet --
-- including on local test databases -- rather than failing the migration.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed; skipping job scheduling';
    return;
  end if;

  perform cron.unschedule(jobname)
    from cron.job
    where jobname in (
      'open-ready-next-days', 'daily-cron-nudge', 'daily-cron-autoskip',
      'daily-cron-inactivity-check', 'weekly-cron-leaderboard'
    );

  -- Pure SQL advancement: opens the next day promptly at the 24h mark.
  perform cron.schedule('open-ready-next-days', '*/15 * * * *',
    $job$select public.open_ready_next_days()$job$);

  -- Every 15 min so nudges land during each member's local waking hours.
  perform cron.schedule('daily-cron-nudge', '*/15 * * * *',
    $job$select public.dispatch_edge_function('daily-cron-nudge', '{}'::jsonb)$job$);

  perform cron.schedule('daily-cron-autoskip', '15 0 * * *',
    $job$select public.dispatch_edge_function('daily-cron-autoskip', '{}'::jsonb)$job$);

  perform cron.schedule('daily-cron-inactivity-check', '30 0 * * *',
    $job$select public.dispatch_edge_function('daily-cron-inactivity-check', '{}'::jsonb)$job$);

  perform cron.schedule('weekly-cron-leaderboard', '0 0 * * 1',
    $job$select public.dispatch_edge_function('weekly-cron-leaderboard', '{}'::jsonb)$job$);
end
$$;
