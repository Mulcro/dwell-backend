-- Core schema. Mirrors docs/backend_design.md 3.1.
-- Additions beyond the doc are marked PHASE1 (see docs/plan/, Phase 1).

create type media_type as enum ('text', 'voice');
create type source_type as enum ('youversion_plan', 'custom');
create type day_status as enum ('open', 'threshold_met', 'complete', 'missed');
create type challenge_status as enum ('forming', 'active', 'paused', 'completed', 'abandoned', 'expired_incomplete');
create type insight_scope as enum ('day_instance', 'group_challenge');
-- PHASE1 #3: inactivity_prompt added so the Continue/Pause/End prompt has a type.
create type insight_type as enum ('group_pulse', 'nudge', 'end_summary', 'fallback_recap', 'inactivity_prompt');

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  preferred_language text not null default 'en',
  timezone text not null,
  push_token text,
  created_at timestamptz not null default now()
);

create table plan_challenges (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_type source_type not null default 'custom',
  day_count int not null check (day_count > 0),
  youversion_plan_id text,
  youversion_deep_link text
);

create table plan_days (
  plan_challenge_id uuid not null references plan_challenges(id) on delete cascade,
  day_index int not null,
  passage_ref text not null,
  primary key (plan_challenge_id, day_index)
);

create table groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_challenge_id uuid not null references plan_challenges(id),
  catch_up_threshold_pct int not null default 50 check (catch_up_threshold_pct between 1 and 100),
  auto_skip_after_days int not null default 3 check (auto_skip_after_days > 0),
  challenge_status challenge_status not null default 'forming',
  -- base64url: 9 bytes = 12 chars, no padding, URL-safe for magic links
  invite_token text not null unique default translate(encode(gen_random_bytes(9), 'base64'), '+/', '-_'),
  -- PHASE1 #3: inactivity prompt state, written only by daily-cron-inactivity-check.
  consecutive_silent_days int not null default 0,
  prompt_pending boolean not null default false,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table day_instances (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  day_index int not null,
  date date not null,
  passage_ref text not null,
  -- when this day became postable; drives the rolling 24h window, is_late, and advancement
  opened_at timestamptz not null default now(),
  status day_status not null default 'open',
  participation_count int not null default 0,
  consecutive_below_threshold_count int not null default 0,
  unique (group_id, day_index)
);

create table reflections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  day_instance_id uuid not null references day_instances(id) on delete cascade,
  media_type media_type not null,
  content text,
  transcript text,
  translated_text jsonb,
  language text not null,
  sentiment_tag text,
  moderation_status text not null default 'pending'
    check (moderation_status in ('pending', 'approved', 'flagged')),
  is_late boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, day_instance_id)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  reflection_id uuid not null references reflections(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create table reactions (
  id uuid primary key default gen_random_uuid(),
  reflection_id uuid not null references reflections(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (reflection_id, user_id, emoji)
);

create table ai_insights (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  day_instance_id uuid references day_instances(id) on delete cascade,
  -- null = group-wide (pulse, end summary); set = personal nudge
  target_user_id uuid references users(id) on delete cascade,
  scope insight_scope not null,
  type insight_type not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table leaderboard_entries (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  week_start date not null,
  user_id uuid not null references users(id) on delete cascade,
  participation_score int not null,
  unique (group_id, week_start, user_id)
);

-- Indexes for the hot lookup paths (threshold counting, day listing, feed reads).
create index on group_members (user_id);
create index on day_instances (group_id, status);
create index on reflections (day_instance_id, moderation_status);
create index on reflections (user_id, created_at);
create index on comments (reflection_id);
create index on reactions (reflection_id);
create index on ai_insights (group_id, created_at);
create index on ai_insights (target_user_id) where target_user_id is not null;
