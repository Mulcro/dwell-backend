-- Realtime plumbing: the client subscribes to exactly these tables, and each needs FULL
-- replica identity for RLS to be applied to the rows it receives.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- Named rather than counted: the point is WHICH tables are exposed, and a count passes
-- just as happily when one is swapped for another.
select set_eq(
  $$select tablename::text from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'$$,
  $$values ('day_instances'), ('ai_insights'), ('groups'), ('group_members')$$,
  'exactly these four tables are published');

select is(
  (select relreplident::text from pg_class where relname = 'day_instances'),
  'f', 'day_instances replicates full rows so RLS can be applied');
select is(
  (select relreplident::text from pg_class where relname = 'ai_insights'),
  'f', 'ai_insights replicates full rows so RLS can be applied');

-- Added 2026-10-01: without these a member joining never reached the invite screen,
-- and a group going forming -> active when they did never arrived. The client was
-- polling every 8 seconds instead.
select is(
  (select relreplident::text from pg_class where relname = 'groups'),
  'f', 'groups replicates full rows so RLS can be applied');
select is(
  (select relreplident::text from pg_class where relname = 'group_members'),
  'f', 'group_members replicates full rows so RLS can be applied');

-- Publishing them must not widen who sees what: Realtime re-checks RLS per subscriber.
select is(
  (select relrowsecurity from pg_class where oid = 'public.group_members'::regclass),
  true, 'and group_members still enforces RLS');

-- reflections must never be published: postgres_changes cannot redact columns, so a
-- subscription would hand over reflection content the viewer has not earned.
select is(
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'reflections'),
  0, 'reflections are deliberately not published');

select is(
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'day_instances'),
  1, 'day_instances carries the content-free participation signal');

select * from finish();
rollback;
