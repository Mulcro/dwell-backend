-- The Group Pulse was written once, from whoever had posted at the instant the day
-- tipped over, and never again.
--
-- With a 50% threshold that is typically half the group: a probe on prod produced a card
-- built from ONE of three reflections, and anyone who posted afterwards never appeared in
-- it at all. The card is meant to be the group seeing itself, so it has to catch up.
--
-- Dispatch now fires on every approval once the day is at or past its threshold.
-- generate-group-pulse decides whether there is anything new to say, so a redundant call
-- costs one cheap read and nothing else.

create or replace function public.check_day_threshold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_opened_at timestamptz;
  v_pct int;
  v_member_count int;
  v_posted_count int;
  v_flipped int;
begin
  select group_id, opened_at into v_group_id, v_opened_at
    from day_instances where id = new.day_instance_id;

  select catch_up_threshold_pct into v_pct from groups where id = v_group_id;

  -- Members who had joined before this day opened; a late joiner never changes a past day's math.
  select count(*) into v_member_count from group_members gm
    where gm.group_id = v_group_id and gm.joined_at <= v_opened_at;

  -- Only APPROVED reflections count toward the gate; pending and flagged never do.
  select count(*) into v_posted_count from reflections
    where day_instance_id = new.day_instance_id and moderation_status = 'approved';

  update day_instances set participation_count = v_posted_count
    where id = new.day_instance_id;

  if v_member_count > 0
     and (v_posted_count::numeric / v_member_count::numeric) * 100 >= v_pct then

    update day_instances set status = 'threshold_met'
      where id = new.day_instance_id and status = 'open';

    get diagnostics v_flipped = row_count;  -- 1 only for the call that actually flips it

    -- Dispatched on the flip AND on every approval after it. The first call writes the
    -- card; later ones let it take in the people who posted once the day was already
    -- open. Without this the pulse is a snapshot of the threshold moment forever.
    perform public.dispatch_edge_function(
      'generate-group-pulse',
      jsonb_build_object('day_instance_id', new.day_instance_id)
    );
  end if;

  return new;
end;
$$;

revoke all on function public.check_day_threshold() from public, anon, authenticated;
