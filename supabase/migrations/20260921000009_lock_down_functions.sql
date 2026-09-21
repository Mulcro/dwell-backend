-- Supabase ships `alter default privileges ... grant all on functions to anon,
-- authenticated, service_role`, so every function created here is executable by both
-- client roles the moment it exists. Combined with SECURITY DEFINER that is privilege
-- escalation: an anon caller could advance every group's days, or make the database
-- POST to an Edge Function bearing the service role key.
--
-- Revoking from PUBLIC is not enough -- those are explicit per-role grants, so the
-- roles must be named. Nothing in the design doc covers this.
--
-- The RLS helpers (is_group_member, shares_group_with, is_reflection_unlocked) stay
-- callable: they answer only about the caller's own auth.uid(), and the policies
-- themselves depend on them.

revoke all on function public.dispatch_edge_function(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.open_ready_next_days()
  from public, anon, authenticated;
revoke all on function public.check_day_threshold()
  from public, anon, authenticated;
revoke all on function public.handle_new_auth_user()
  from public, anon, authenticated;

-- pg_cron runs its jobs as postgres. Trigger functions are invoked by the system and
-- do not require the writing role to hold EXECUTE.
grant execute on function public.dispatch_edge_function(text, jsonb) to postgres;
grant execute on function public.open_ready_next_days() to postgres;

-- Same story for reflections: the design doc revokes INSERT from authenticated, but the
-- default grants hand anon the full set too. RLS already denies (no policy), but the
-- table grants should not contradict the rule that only /submit-reflection writes here.
revoke insert, update, delete on reflections from anon;
