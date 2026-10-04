-- The weekly recap is an insight type of its own, so the client can tell it from the
-- end-of-challenge summary while decoding the same card shape.
begin;
create extension if not exists pgtap with schema extensions;
select plan(2);

select ok('weekly_recap' = any(enum_range(null::insight_type)::text[]),
  'weekly_recap is an insight type');
select ok(col_description('public.ai_insights'::regclass,
            (select attnum from pg_attribute
              where attrelid = 'public.ai_insights'::regclass and attname = 'payload'))
          like '%weekly_recap%',
  'and the payload column documents the shape it carries');

select * from finish();
rollback;
