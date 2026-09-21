-- Advancement: threshold-gated AND paced one-per-24h.
--
-- The next day opens only once the current day is threshold_met and has been open at
-- least 24 hours. Pure SQL, no HTTP of its own, so it is a plpgsql function run directly
-- by pg_cron rather than an Edge Function.

create or replace function public.open_ready_next_days()
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
    select di.*, g.plan_challenge_id
    from day_instances di
    join groups g on g.id = di.group_id
    where g.challenge_status = 'active'
      and di.status = 'threshold_met'
      and di.opened_at <= now() - interval '24 hours'
      and not exists (
        select 1 from day_instances nx
        where nx.group_id = di.group_id and nx.day_index = di.day_index + 1
      )
    for update of di skip locked  -- concurrent cron ticks never process the same day twice
  loop
    select day_count into v_day_count from plan_challenges where id = r.plan_challenge_id;

    update day_instances set status = 'complete' where id = r.id;

    if r.day_index < v_day_count then
      insert into day_instances (group_id, day_index, date, passage_ref, opened_at, status)
      select r.group_id, r.day_index + 1, current_date, pd.passage_ref, now(), 'open'
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
