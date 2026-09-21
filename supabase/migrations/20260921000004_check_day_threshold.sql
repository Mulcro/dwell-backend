-- Day-gating: the core business rule.
--
-- PHASE1 #6: every in-database call out to an Edge Function goes through one helper
-- rather than repeating the Vault lookup and pg_net call. It no-ops when the secrets
-- are not configured (local runs, tests), and tests replace it with a recording stub.

create or replace function public.dispatch_edge_function(p_name text, p_body jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';

  -- Not configured yet: skip rather than fail the transaction that triggered us.
  if v_url is null or v_key is null then
    raise notice 'dispatch_edge_function(%): vault secrets missing, skipped', p_name;
    return;
  end if;

  perform net.http_post(
    url := v_url || '/functions/v1/' || p_name,
    body := p_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    )
  );
end;
$$;

-- Fires on reflection APPROVAL, never on the raw insert, so moderation always runs
-- before a post can count. Counts approved reflections only, guards the member-count
-- division against zero, and dispatches group-pulse only from the call that actually
-- flips the day (so it can never double-fire).
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

    if v_flipped = 1 then
      perform public.dispatch_edge_function(
        'generate-group-pulse',
        jsonb_build_object('day_instance_id', new.day_instance_id)
      );
    end if;
  end if;

  return new;
end;
$$;

create trigger on_reflection_approved
  after update of moderation_status on reflections
  for each row
  when (new.moderation_status = 'approved' and old.moderation_status is distinct from 'approved')
  execute function public.check_day_threshold();
