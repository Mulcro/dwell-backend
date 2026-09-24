-- Reading rhythm. Design doc 4.1 says the creator picks a frequency, but the schema and
-- /create-group never carried one, so every group advanced daily whatever the client
-- showed. This adds the missing half.
--
-- Weekday boundaries are evaluated in the group's own timezone, set from the creator's
-- device at setup. UTC would be simpler and wrong for anyone far from it: a Friday
-- evening in Auckland is already Saturday in UTC.

create type day_frequency as enum ('daily', 'weekdays', 'three_per_week');

alter table groups
  add column frequency day_frequency not null default 'daily',
  -- IANA name, e.g. 'Pacific/Auckland'. Defaulted rather than required so existing rows
  -- keep working; 'daily' groups never consult it anyway.
  add column timezone text not null default 'UTC';

comment on column groups.frequency is
  'How often a new reading day may open. Only gates the OPENING of the next day.';
comment on column groups.timezone is
  'IANA timezone deciding which local day it is for weekday-based frequencies.';

-- May a new day open for this group right now?
--
-- three_per_week is Mon/Wed/Fri rather than "any 3 days in a rolling 7": a fixed
-- cadence is something a group can actually plan around.
create or replace function public.day_opens_today(
  p_frequency day_frequency,
  p_timezone text,
  p_at timestamptz default now()
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

  if p_frequency = 'weekdays' then
    return v_dow between 1 and 5;           -- Monday..Friday
  else
    return v_dow in (1, 3, 5);              -- Monday, Wednesday, Friday
  end if;
end;
$$;

revoke all on function public.day_opens_today(day_frequency, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.day_opens_today(day_frequency, text, timestamptz) to postgres;

-- Advancement now respects the rhythm. The current day is deliberately left as
-- threshold_met on a rest day rather than completed: completing it would drop it out of
-- this function's own search, and no next day would ever open.
--
-- p_now exists so the rhythm can be tested against a fixed Saturday or Monday instead of
-- whatever day the suite happens to run on. pg_cron calls it with no argument.
drop function if exists public.open_ready_next_days();

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
    select di.*, g.plan_challenge_id, g.frequency, g.timezone
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
       and not public.day_opens_today(r.frequency, r.timezone, p_now) then
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

-- The signature changed, so the grants from 20260921000009 no longer apply.
revoke all on function public.open_ready_next_days(timestamptz)
  from public, anon, authenticated;
grant execute on function public.open_ready_next_days(timestamptz) to postgres;
