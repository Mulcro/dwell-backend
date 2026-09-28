-- Reading rhythm, part two: the day pattern behind four_per_week and custom.
--
-- custom carries an explicit set of ISO weekdays (1 = Monday ... 7 = Sunday) so a group
-- can choose its own shape. The named frequencies stay named rather than being rewritten
-- as masks -- "weekdays" is what the group picked and what the UI shows, and collapsing
-- it into {1,2,3,4,5} would lose that.

alter table groups
  add column custom_days int[] check (
    custom_days is null
    or (array_length(custom_days, 1) between 1 and 7
        and custom_days <@ array[1,2,3,4,5,6,7])
  );

comment on column groups.custom_days is
  'ISO weekdays a day may open on, for frequency = custom. Null for every other frequency.';

-- A custom group with no days would never open another day again.
alter table groups add constraint custom_days_present
  check (frequency <> 'custom' or (custom_days is not null and array_length(custom_days, 1) >= 1));

drop function if exists public.day_opens_today(day_frequency, text, timestamptz);

create or replace function public.day_opens_today(
  p_frequency day_frequency,
  p_timezone text,
  p_at timestamptz default now(),
  p_custom_days int[] default null
)
returns boolean
language plpgsql
immutable
as $$
declare
  v_dow int;
begin
  if p_frequency = 'daily' then
    return true;
  end if;

  -- A bad timezone must not stall a group forever; fall back to UTC.
  begin
    v_dow := extract(isodow from (p_at at time zone p_timezone));
  exception when others then
    v_dow := extract(isodow from (p_at at time zone 'UTC'));
  end;

  case p_frequency
    when 'weekdays'       then return v_dow between 1 and 5;   -- Mon-Fri
    when 'three_per_week' then return v_dow in (1, 3, 5);      -- Mon, Wed, Fri
    when 'four_per_week'  then return v_dow in (1, 2, 4, 5);   -- Mon, Tue, Thu, Fri
    when 'custom'         then return p_custom_days is not null and v_dow = any(p_custom_days);
    else return true;
  end case;
end;
$$;

revoke all on function public.day_opens_today(day_frequency, text, timestamptz, int[])
  from public, anon, authenticated;
grant execute on function public.day_opens_today(day_frequency, text, timestamptz, int[]) to postgres;
-- The cron autoskip function calls this over PostgREST as the service role.
grant execute on function public.day_opens_today(day_frequency, text, timestamptz, int[]) to service_role;

-- Advancement has to pass the group's custom days through to the rhythm check.
create or replace function public.open_ready_next_days(p_now timestamptz default now())
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

revoke all on function public.open_ready_next_days(timestamptz)
  from public, anon, authenticated;
grant execute on function public.open_ready_next_days(timestamptz) to postgres;
