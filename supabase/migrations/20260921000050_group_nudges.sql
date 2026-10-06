-- KAN-63: a member nudges the group.
--
-- One nudge per sender per group per day, where "day" is the group's current day
-- instance -- the same day the "who hasn't posted" check reads, so the two can never
-- disagree. The limit is a unique key, not a check in the function: two taps landing at
-- once both reach the insert, and only one can win.
--
-- Written only by the nudge-group function with the service role. RLS is on with no
-- policies, so no client can read or write it directly.

create table group_nudges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  day_instance_id uuid not null references day_instances(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  recipients int not null default 0,
  created_at timestamptz not null default now(),
  unique (group_id, day_instance_id, sender_id)
);

comment on table group_nudges is
  'One row per member nudge (KAN-63). The unique key is the one-per-day limit.';

alter table group_nudges enable row level security;
