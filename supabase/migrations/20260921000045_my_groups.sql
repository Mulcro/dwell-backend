-- KAN-46: every group someone belongs to, the current one first.
--
-- Each challenge is its own group row (KAN-29 resolved: "same crew, new plan" is a new
-- group), so a person accumulates finished groups over time and the app needs to list
-- them and to know which one to open into. The rule is computed here so every client
-- applies it the same way: the row that is still going comes first; otherwise the most
-- recently active finished group. The client takes the first row as current.
--
-- SECURITY DEFINER so the counts are the group's, not what RLS would let the caller see
-- of other members' sealed reflections. Keyed on auth.uid() and nothing else: it takes
-- no argument, so it can only ever describe the caller's own memberships.

create or replace function public.my_groups()
returns table (
  id uuid,
  name text,
  challenge_status challenge_status,
  plan_challenge_id uuid,
  plan_title text,
  plan_image_path text,
  day_count int,
  member_count int,
  reflection_count int,
  created_at timestamptz,
  last_activity_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    g.id,
    g.name,
    g.challenge_status,
    pc.id,
    pc.title,
    pc.image_path,
    pc.day_count,
    (select count(*) from group_members m where m.group_id = g.id)::int,
    (select count(*) from reflections r
       join day_instances d on d.id = r.day_instance_id
      where d.group_id = g.id and r.moderation_status = 'approved')::int,
    g.created_at,
    -- greatest() ignores nulls, so a group with no days or posts falls back to created_at.
    greatest(
      g.created_at,
      (select max(d.opened_at) from day_instances d where d.group_id = g.id),
      (select max(r.created_at) from reflections r
         join day_instances d on d.id = r.day_instance_id
        where d.group_id = g.id and r.moderation_status = 'approved')
    ) as last_activity_at
  from group_members me
  join groups g on g.id = me.group_id
  join plan_challenges pc on pc.id = g.plan_challenge_id
  where me.user_id = auth.uid()
  order by
    g.challenge_status in ('completed', 'abandoned', 'expired_incomplete'),
    last_activity_at desc,
    g.created_at desc
$$;

revoke all on function public.my_groups() from public, anon, authenticated;
grant execute on function public.my_groups() to authenticated;
