-- KAN-19: the plan picker shows only finished plans.
--
-- The three plans from the 02b screens carry a description, a key verse, day titles and
-- cover art; the two from the first redesign carry none of that, and the pair looked
-- unfinished side by side. Rather than delete rows that live groups point at, a plan is
-- `listed` or not: an unlisted plan vanishes from the picker, but anyone in a group that
-- is reading it can still see it and its days. Flipping the flag back is one update.

alter table plan_challenges add column listed boolean not null default true;

comment on column plan_challenges.listed is
  'Shown in the plan picker. An unlisted plan stays readable to members of a group on it.';

update plan_challenges set listed = false
 where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');

-- Visibility follows the flag, with membership as the exception so a group can render
-- the plan it is reading. The exception means a member's catalogue read includes their
-- own unlisted plan, so the picker itself filters on `listed`; RLS cannot tell a picker
-- read from a group's own plan read. A plan's days follow the plan.
drop policy "read plans" on plan_challenges;
create policy "read listed plans and your own" on plan_challenges
  for select to authenticated
  using (
    listed
    or exists (
      select 1 from groups g
      where g.plan_challenge_id = plan_challenges.id
        and public.is_group_member(g.id)
    )
  );

drop policy "read plan days" on plan_days;
create policy "read days of plans you can see" on plan_days
  for select to authenticated
  using (
    exists (
      select 1 from plan_challenges pc
      where pc.id = plan_days.plan_challenge_id
        and (
          pc.listed
          or exists (
            select 1 from groups g
            where g.plan_challenge_id = pc.id
              and public.is_group_member(g.id)
          )
        )
    )
  );
