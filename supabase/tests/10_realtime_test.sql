-- Realtime plumbing: the client subscribes to exactly these tables, and each needs FULL
-- replica identity for RLS to be applied to the rows it receives.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

select is(
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public'),
  2, 'exactly two tables are published');

select is(
  (select relreplident::text from pg_class where relname = 'day_instances'),
  'f', 'day_instances replicates full rows so RLS can be applied');
select is(
  (select relreplident::text from pg_class where relname = 'ai_insights'),
  'f', 'ai_insights replicates full rows so RLS can be applied');

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
