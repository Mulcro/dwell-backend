-- Debug time travel: move one group a day forward or back, for the in-app debug UI.
--
-- The /debug-day Edge Function is the only caller, and it only exists when the
-- DEBUG_DAY_ENABLED secret is set, so production never exposes this. Advancing reuses
-- the exact mechanics of scripts/advance-day.sh: backdate the current day past the 24h
-- gate, force its threshold met, and run the real sweep for this one group, so
-- completion and the end-of-challenge transition behave as in production. Rewinding is
-- the inverse: drop the newest day (its reflections cascade away -- debug groups only)
-- and reopen the one before it, or reopen the final day of a completed challenge.

create or replace function public.debug_advance_day(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g record;
  v_clock timestamptz;
  v_status day_status;
  v_index int;
begin
  select * into g from groups where id = p_group_id for update;
  if not found then
    raise exception 'group not found';
  end if;
  if g.challenge_status <> 'active' then
    raise exception 'only an active group advances (status is %)', g.challenge_status;
  end if;

  -- Today if it is a reading day for this group's rhythm, else its most recent one, so
  -- a weekdays group can still be moved on a Saturday (same rule as advance-day.sh).
  select now() - make_interval(days => n) into v_clock
  from generate_series(0, 6) n
  where public.day_opens_today(g.frequency, g.timezone, now() - make_interval(days => n), g.custom_days)
  order by n limit 1;

  update day_instances d
     set opened_at = v_clock - interval '25 hours',
         status = case when d.status = 'open' then 'threshold_met'::day_status else d.status end
   where d.group_id = p_group_id
     and d.day_index = (select max(x.day_index) from day_instances x where x.group_id = p_group_id)
  returning d.status, d.day_index into v_status, v_index;
  if v_index is null then
    raise exception 'the group has no day yet; has it started?';
  end if;
  if v_status <> 'threshold_met' then
    raise exception 'day % is %; nothing to advance', v_index, v_status;
  end if;

  perform public.open_ready_next_days(v_clock, p_group_id);

  return (
    select jsonb_build_object('day_index', max(d.day_index), 'challenge_status', g2.challenge_status)
    from groups g2 join day_instances d on d.group_id = g2.id
    where g2.id = p_group_id
    group by g2.challenge_status
  );
end;
$$;

create or replace function public.debug_rewind_day(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g record;
  v_max int;
begin
  select * into g from groups where id = p_group_id for update;
  if not found then
    raise exception 'group not found';
  end if;
  if g.challenge_status not in ('active', 'completed') then
    raise exception 'only an active or completed challenge rewinds (status is %)', g.challenge_status;
  end if;

  select max(day_index) into v_max from day_instances where group_id = p_group_id;
  if v_max is null then
    raise exception 'the group has no day yet; has it started?';
  end if;

  -- A completed challenge reopens its final day; the end-summary insight stays.
  if g.challenge_status = 'completed' then
    update groups set challenge_status = 'active' where id = p_group_id;
    update day_instances set status = 'open', opened_at = now()
     where group_id = p_group_id and day_index = v_max;
    return jsonb_build_object('day_index', v_max, 'challenge_status', 'active');
  end if;

  if v_max = 1 then
    raise exception 'already on day 1; nothing to rewind';
  end if;

  delete from day_instances where group_id = p_group_id and day_index = v_max;
  update day_instances set status = 'open', opened_at = now()
   where group_id = p_group_id and day_index = v_max - 1;
  return jsonb_build_object('day_index', v_max - 1, 'challenge_status', g.challenge_status);
end;
$$;

revoke all on function public.debug_advance_day(uuid) from public, anon, authenticated;
revoke all on function public.debug_rewind_day(uuid) from public, anon, authenticated;
grant execute on function public.debug_advance_day(uuid) to service_role;
grant execute on function public.debug_rewind_day(uuid) to service_role;
