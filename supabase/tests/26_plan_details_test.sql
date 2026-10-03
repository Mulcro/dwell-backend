-- Item 50: plan detail for the Plans screens, and the three plans the design defines.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

select has_column('public', 'plan_challenges', 'description', 'a plan carries a description');
select has_column('public', 'plan_challenges', 'key_verse', 'and a key verse');
select has_column('public', 'plan_challenges', 'key_verse_ref', 'with its reference');
select has_column('public', 'plan_days', 'title', 'each day carries a theme line');

-- The design plans are seeded whole: every piece of copy, as many days as they claim,
-- every day titled. Keyed by title, so a plan that lost a field cannot drop out of
-- the check by losing it.
create temp view design_plans as
  select * from plan_challenges where title in ('Be Still', 'Better Together', 'Abide');

select is((select count(*)::int from design_plans), 3, 'the three design plans exist');
select is((select count(*)::int from design_plans
           where coalesce(description, '') = ''
              or coalesce(key_verse, '') = ''
              or coalesce(key_verse_ref, '') = ''
              or coalesce(image_path, '') = ''),
  0, 'each has a description, a key verse, its reference and cover art');
select is((select count(*)::int from design_plans p
           where p.day_count <> (select count(*) from plan_days d where d.plan_challenge_id = p.id)),
  0, 'each has exactly as many days as it claims');
select is((select count(*)::int from plan_days d
           join design_plans p on p.id = d.plan_challenge_id
           where coalesce(d.title, '') = ''),
  0, 'and every one of those days has a title');

-- The client draws the quote marks, so the verse must not carry its own.
select is((select count(*)::int from design_plans
           where key_verse like '"%' or key_verse like '%"'
              or key_verse like '“%' or key_verse like '%”'),
  0, 'key verses are stored without quote marks');

select * from finish();
rollback;
