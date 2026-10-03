-- Item 50: plan detail for the Plans screens, and the three plans the design defines.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select has_column('public', 'plan_challenges', 'description', 'a plan carries a description');
select has_column('public', 'plan_challenges', 'key_verse', 'and a key verse');
select has_column('public', 'plan_challenges', 'key_verse_ref', 'with its reference');
select has_column('public', 'plan_days', 'title', 'each day carries a theme line');

-- The design plans are seeded whole: as many days as they claim, every day titled.
select is((select count(*)::int from plan_challenges
           where title in ('Be Still', 'Better Together', 'Abide')),
  3, 'the three design plans exist');
select is((select count(*)::int from plan_challenges p
           where p.description is not null
             and p.day_count <> (select count(*) from plan_days d where d.plan_challenge_id = p.id)),
  0, 'a described plan has exactly as many days as it claims');
select is((select count(*)::int from plan_days d
           join plan_challenges p on p.id = d.plan_challenge_id
           where p.description is not null and coalesce(d.title, '') = ''),
  0, 'and every one of its days has a title');

-- The client draws the quote marks, so the verse must not carry its own.
select is((select count(*)::int from plan_challenges
           where key_verse like '"%' or key_verse like '%"'
              or key_verse like '“%' or key_verse like '%”'),
  0, 'key verses are stored without quote marks');

select * from finish();
rollback;
