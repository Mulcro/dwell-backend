-- Let the advancement sweep be pointed at a single group.
--
-- scripts/advance-day.sh moves one group forward by running the real sweep, so that
-- completion and the end-of-challenge transition happen exactly as in production. An
-- unfiltered sweep would also advance any other group that happened to be due, and when
-- the script judges the rhythm as of a group's last reading day it must not apply that
-- clock to anyone else. pg_cron keeps calling it with no arguments, which is unchanged.

drop function if exists public.open_ready_next_days(timestamptz);

create or replace function public.open_ready_next_days(
  p_now timestamptz default now(),
  p_group_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_day_count int;
begin
  for r in
    select di.*, g.plan_challenge_id, g.frequency, g.timezone, g.custom_days
    from day_instances di
    join groups g on g.id = di.group_id
    where g.challenge_status = 'active'
      and (p_group_id is null or di.group_id = p_group_id)
      and di.status = 'threshold_met'
      and di.opened_at <= p_now - interval '24 hours'
      and not exists (
        select 1 from day_instances nx
        where nx.group_id = di.group_id and nx.day_index = di.day_index + 1
      )
    for update of di skip locked
  loop
    select day_count into v_day_count from plan_challenges where id = r.plan_challenge_id;

    -- Rest day: leave everything untouched and try again on the next allowed day. The
    -- final day is exempt, since finishing opens nothing.
    if r.day_index < v_day_count
       and not public.day_opens_today(r.frequency, r.timezone, p_now, r.custom_days) then
      continue;
    end if;

    update day_instances set status = 'complete' where id = r.id;

    if r.day_index < v_day_count then
      insert into day_instances (group_id, day_index, date, passage_ref, opened_at, status)
      select r.group_id, r.day_index + 1, (p_now at time zone 'UTC')::date, pd.passage_ref, p_now, 'open'
      from plan_days pd
      where pd.plan_challenge_id = r.plan_challenge_id
        and pd.day_index = r.day_index + 1
      on conflict (group_id, day_index) do nothing;
    else
      update groups set challenge_status = 'completed' where id = r.group_id;
      perform public.dispatch_edge_function(
        'end-of-challenge-summary',
        jsonb_build_object('group_id', r.group_id)
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.open_ready_next_days(timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.open_ready_next_days(timestamptz, uuid) to postgres;
