-- Recordings must not outlive the reflection they belong to.
--
-- Deleting an account cascades auth.users -> users -> reflections, but Storage knows
-- nothing about any of it: the row goes and the audio stays. For an account deletion
-- that is a privacy failure, not just wasted bytes.
--
-- The object cannot be removed from SQL -- storage.protect_delete() refuses direct
-- deletes outright and points at the Storage API -- so the trigger records the intent
-- and cleanup-media carries it out.

create table media_deletions (
  path text primary key,
  queued_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text
);

alter table media_deletions enable row level security;
-- No policies: only the service role touches this.

comment on table media_deletions is
  'Recordings whose reflection is gone, awaiting removal from Storage by cleanup-media.';

create or replace function public.queue_media_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.media_path is not null then
    -- on conflict: the same path can be queued twice if a retry re-deletes a row.
    insert into media_deletions (path) values (old.media_path)
    on conflict (path) do nothing;
  end if;
  return old;
end;
$$;

create trigger reflections_queue_media_deletion
  after delete on reflections
  for each row execute function public.queue_media_deletion();

revoke all on function public.queue_media_deletion() from public, anon, authenticated;

-- Every 15 minutes: deletions should follow an account closure closely, not eventually.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed; skipping cleanup-media scheduling';
    return;
  end if;

  perform cron.unschedule(jobname) from cron.job where jobname = 'cleanup-media';
  perform cron.schedule('cleanup-media', '*/15 * * * *',
    $job$select public.dispatch_edge_function('cleanup-media', '{}'::jsonb)$job$);
end
$$;
