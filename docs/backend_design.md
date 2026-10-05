# Backend Design Doc

## Purpose

Technical design for Dwell's backend — written to be handed directly to **Claude Code as the implementation brief**. Companion to the MVP Spec — that page defines *what* the app does; this one defines *how* it's built. Organized by concern: **API → Auth → Database → Business Logic → Infrastructure.**

## Architecture Overview

| **Layer** | **Choice** |
| --- | --- |
| Client | Swift + SwiftUI (solo build) |
| Auth | Google (live) and email/password via Supabase Auth; YouVersion sign-in via a verification bridge, built and verified (see 2). Apple is not yet configured -- it needs a paid Apple Developer membership |
| Database | Supabase Postgres |
| Realtime | Supabase Realtime — client subscribes directly to table changes, no custom socket/polling layer |
| Compute | Supabase Edge Functions (TypeScript/Deno) |
| AI | OpenAI, tiered — cheap/fast model for classification, mid-tier for generation |
| Moderation | OpenAI Moderation endpoint (free), standalone from the main LLM call |
| Speech-to-text | On-device Apple Speech framework — client-side only |
| Push notifications | Live. daily-cron-nudge writes the in-app nudge row, then hands the same words to send-push, which delivers over raw APNs with a provider (.p8) token. Best effort: a missing or dead token never fails the nudge (see 5.3) |

---

# 1. API

**Yes — there are two API surfaces, not one.** Most reads and simple writes go straight through Supabase's **auto-generated REST API (PostgREST)**, protected entirely by Row-Level Security — no server code needed for those. Anything with actual business logic (moderation, threshold math, AI calls, side effects) is a **custom Edge Function**. Rule of thumb used throughout this doc: if a write has no side effect beyond "save this row," it's a direct PostgREST call; if it triggers logic, notifications, or an external API, it's an Edge Function.

## 1.1 Client-Facing Edge Functions

Base URL: `https://<project-ref>.supabase.co/functions/v1/<name>`. All require a valid Supabase session unless noted otherwise.

| **Endpoint** | **Method** | **Auth** | **Request → Response** | **Description** |
| --- | --- | --- | --- | --- |
| /create-group | POST | Required | { name, plan_challenge_id, frequency?, timezone?, auto_skip_after_days?, continues_group_id? } → { group_id, invite_token } | Creates a group in forming state plus a group_members row for the creator. frequency is 'daily' (default), 'weekdays' or 'three_per_week'; timezone is the creator's IANA zone, which decides which local day it is for the weekday-based rhythms. The unlock threshold is 50% for every group, existing ones included (decided 2026-10-03; migration 44 brought older groups into line); custom thresholds are not supported, so a catch_up_threshold_pct in the body is accepted and ignored (and logged): every build shipped before KAN-43 removed the slider still sends one (KAN-49). One challenge at a time (KAN-46): 409 "Your group's challenge is still going. Finish it or leave the group first." while the caller belongs to any group not completed/abandoned/expired_incomplete; finished groups do not count, so "same crew, new plan" is a new group. Optional continues_group_id (KAN-50, same crew, new plan): the finished group this one continues; 404 if the caller was never in it, 409 "That group's challenge hasn't ended yet" if it has not ended. Stored on groups.continues_group_id, which is what lets that group's members see and accept it. |
| /join-group | POST | Required | { invite_token } or { group_id } (exactly one; both is a 400) → { group_id, challenge_status } | Adds the caller to the group. If this join brings membership to 2, flips the group to active and creates the Day 1 row One challenge at a time (KAN-46): the same 409 while the caller belongs to any other group still going; re-joining the same group stays a no-op. Also accepts { group_id } instead of { invite_token } (KAN-50): allowed only for a member of the finished group it continues; anyone else gets the same 404 as an unknown invite. Same rules otherwise. |
| /preview-group | POST (RPC) | None — public | { invite_token } → { name, plan_title } | Lets the in-browser invite-link flow show "You've been invited to [Group] doing [Plan]" before the visitor signs in or installs the app. Newly identified while writing this section — the MVP Spec's "works in-browser before forcing install" join flow implied this endpoint but it was never explicitly spec'd until now. Implemented as a security definer Postgres function (see Database) rather than an Edge Function, since it's a single read with no logic |
| /submit-reflection | POST | Required | { day_instance_id, media_type, content?, transcript?, language } → { reflection_id, moderation_status } | Inserts the reflection as moderation_status='pending' (this insert does NOT gate the day) → OpenAI Moderation check → if flagged, stops early (stays hidden, never counts toward threshold); if approved, flips moderation_status to 'approved', and it is that UPDATE that fires check-day-threshold (see Database), plus one tiered-LLM call for the sentiment tag, translations of the reflection (translated_text), a personalized response in the author's language (ai_response) and translations of that response (ai_response_translated), written back onto the row |
| /submit-comment | POST | Required, and the caller must be able to read the reflection (RLS unlock rule) | { reflection_id, media_type?, content?, transcript?, media_path?, media_mime?, media_duration_seconds?, media_peaks?, language? } → 201 { comment_id } | Moderates the reply (text, transcript or image) before anything is written; a refused reply is never written (422) and its upload destroyed. Translates it for group-mates who read another language. After the row is written it pushes the reflection's author (KAN-22): "{first name} replied to your reflection", a preview of about 100 characters in the author's preferred language when a translation exists, and the ids to open the reply. Skipped for a reply to your own reflection or an author with no token, and run after the response via the runtime's waitUntil, so it can never delay or fail the reply |
| /group-challenge-action | POST | Required, must be a group member | { group_id, action: "continue" or "pause" or "end" } → { challenge_status } | Handles the Continue/Pause/End response to the inactivity prompt |
| /debug-day | POST | Required, must be a group member — AND the function answers 404 unless the DEBUG_DAY_ENABLED secret is "true" | { group_id, action: "advance" or "rewind" } → { day_index, challenge_status } | Debug-only time travel for the app's debug UI. "advance" backdates the group's current day past the 24h gate, forces its threshold met, and runs the real sweep for that one group (so completion and end-of-challenge-summary fire exactly as in production); "rewind" deletes the newest day (its reflections cascade away — debug groups only) and reopens the one before it, or reopens the final day of a completed challenge. Production never sets the secret, so the pacing bypass does not exist there; scripts/advance-day.sh remains the operator-side equivalent A rewind is refused (409) when anyone but the caller has posted, replied or reacted on the day it would delete, so no tester can erase a group-mate's words; rewinding a completed challenge also clears its end_summary / fallback_recap row so the summary is written again. Refusals are 409 with the tester-facing message; any other database failure is a plain 500 |

**Not an Edge Function, by design:** updating your own timezone/push_token, and posting a comment, are both plain data writes with no side effects — they go through the Direct Database API below instead. Comments specifically were already decided to skip moderation in the MVP Spec ("trade-off... accepted as smaller than the retention cost of leaving it out"), so there's no logic there to justify a function.

## 1.2 System-Triggered Edge Functions

Not part of the public client-facing surface — invoked only by pg_cron, a database trigger via pg_net, or another function. Listed here because they're still real HTTP endpoints that exist and need deploying.

| **Endpoint** | **Invoked by** | **Description** |
| --- | --- | --- |
| /generate-group-pulse | pg_net POST from the check-day-threshold DB trigger, service-role authenticated | Fetches the day's approved reflections only, one LLM call synthesizing cross-member themes, writes an ai_insights row (group_pulse) |
| /daily-cron-nudge | pg_cron, every 15 min | Decides who to nudge: anyone approaching or past their local day-window (day_instances.opened_at + 24h, sent only during waking hours per users.timezone) without a reflection; a second pass flags the escalated "everyone's quiet" variant after continued silence. MVP: writes the nudge as an ai_insights row (type 'nudge', target_user_id set) for in-app display rather than sending a real push (see 5.3) |
| /send-push | Another function, service-role authenticated (today: daily-cron-nudge, once per nudge row) | { user_id, title, body } → { delivered, reason? }. Looks up users.push_token, POSTs one alert to APNs with the group name as title, and on a 410 nulls the token so a dead device is not retried every tick. No token or a refusal returns delivered: false; it never raises Also takes thread_id (APNs thread-id, grouping notifications) and data (a flat object of strings sent beside aps so the app can open the right screen; an aps key or a non-string value is a 400). Called by daily-cron-nudge (data type nudge, group_id, day_instance_id) and submit-comment (KAN-22: data type reply, group_id, day_instance_id, reflection_id, comment_id; thread-id the reflection) |
| /daily-cron-autoskip | pg_cron, daily 00:15 UTC | Sole writer of consecutive_below_threshold_count: increments it once per day for each active group's current below-threshold day, and once it hits the group's auto_skip_after_days, marks that day missed, opens the next day, and resets the counter to 0 |
| /daily-cron-inactivity-check | pg_cron, daily 00:30 UTC | At 3 consecutive silent days group-wide, surfaces the Continue/Pause/End prompt to every member (once, not re-fired while pending). The same job runs the longer-horizon sweep that flips 14-day-silent, non-completed groups to expired_incomplete and fires end-of-challenge-summary |
| /weekly-cron-leaderboard | pg_cron, weekly Monday 00:00 UTC | Computes each member's own participation_score for the past 7 days per group and writes the leaderboard FIRST. Only then, and only if OPENAI_API_KEY is set, it writes one weekly_recap insight per group for the week just ended: the same card shape as end_summary (headline, members, days_showed_up, days_total) with week_start in the payload. "This week" is the leaderboard's window (reflections posted in it, whichever day they were for); the day counts are the days that opened in it. One per group per week, enforced by a unique index; none when nothing was posted; a recap failing costs only that recap |
| /end-of-challenge-summary | Invoked directly by another function when a group reaches its final day or transitions to abandoned/expired_incomplete | Writes the recap card whenever anything was posted: payload { headline (finishes "You kept coming back to…"), members: [{ user_id, line }] (what each person brought), days_showed_up (days the group cleared), days_total (the plan's length), reflection_count }, with the prose in content and translated_text keyed by the languages the group reads. The type says how much there was: end_summary with three or more reflections, fallback_recap below that (same card, gentler two-sentence prose; prose only when nobody posted). One closing summary per group, enforced by a unique index |

Note: **check-day-threshold and open_ready_next_days are not HTTP endpoints at all** — check-day-threshold is a plain plpgsql trigger, and open_ready_next_days is a plpgsql function run directly by pg_cron (advancement is pure DB work, so it needs no Edge Function). Both are covered under Database, not here, since they have zero API surface.

## 1.3 Direct Database API (PostgREST)

Everything below is a normal authenticated Supabase client call (supabase.from(...)), with Row-Level Security doing all the access control — no custom code on the server.

| **Resource** | **Operations** | **Access pattern** |
| --- | --- | --- |
| groups | select | Any group the caller belongs to |
| group_members | select | Members of the caller's own groups (used to render the member list + names) |
| day_instances | select | All days, past and current, for the caller's groups |
| reflections | select only | Own reflections always visible; group-mates' only once the caller has posted their own approved reflection for that day. Direct insert is REVOKED from the authenticated role, so every write goes through /submit-reflection (service role) and moderation always runs. This is now enforced, not a convention |
| comments | select, insert | Comments on any reflection visible to the caller (i.e., already unlocked for them); insert requires user_id = auth.uid() AND that the target reflection is already unlocked for the caller (enforced in RLS), so you can't comment on a reflection you haven't earned by posting |
| reactions | select, insert, delete | Same visibility rule as comments (reflection must be unlocked for the caller); insert/delete require user_id = auth.uid(). One row per (reflection, user, emoji) |
| ai_insights | select | Any insight belonging to the caller's groups |
| leaderboard_entries | select | Entries for the caller's groups |
| users | select, update | Own profile (update: timezone, push_token, name) plus read-only access to the profiles of anyone sharing a group with the caller (for display names in member lists) |

## 1.4 Realtime Channels

Pub/sub, not request/response — the client subscribes once and receives pushes as rows change.

- day_instances row for the group's current day (filter: group_id=eq.<id>) — status changes (open → threshold_met → complete/missed) AND participation_count update the UI live. This is also the source for the content-free "X of Y posted" indicator, so the count can move without exposing any reflection row before the viewer has posted
- ai_insights inserts scoped to the group (filter: group_id=eq.<id>) — surfaces nudges, group pulse, and end summaries as they land
- reflections: deliberately NOT a postgres_changes channel. postgres_changes filters whole rows by RLS and can't redact columns, so a viewer who hasn't posted receives nothing anyway (they can't SELECT the row), and once unlocked they'd receive full content. The content-free "so-and-so just posted" signal therefore rides on the day_instances.participation_count change above, not on a reflections subscription

---

# 2. Auth

**MVP decision (9/20): ship standard OAuth first.** For the hackathon build we use a standard Supabase Auth provider (Sign in with Apple and/or Google) so the core loop is unblocked immediately, and we add YouVersion login as an option later. The YouVersion Custom OIDC plan below is that fast-follow, kept here so it is ready to slot in; it does not block anything else in this doc. handle_new_auth_user, the users-row seeding, and the post-login profile update all work the same regardless of which provider issued the session.

**YouVersion sign-in: BUILT and verified end to end (2026-09-28).** The Custom OIDC
Provider plan below was abandoned once the provider was actually probed. Three findings
killed it, all confirmed against their live endpoints:

1. **They are a PKCE public client and issue no client secret.** Supabase's custom
   provider performs a confidential-client exchange and never sends a `code_verifier`,
   so it cannot complete their token exchange.
2. **Their OIDC discovery document is stale.** It advertises
   `login.youversion.com/auth/authorize` (404) and an issuer whose own
   `/.well-known/openid-configuration` returns a 401 OAuth fault, so auto-discovery
   cannot work. The live endpoints are on `api.youversion.com`.
3. **Sign-in has three legs, not two.** The first callback is deliberately state-only --
   "identity is bound server-side and the browser-facing callback carries only `state`".
   The state must be replayed to `/auth/callback` before an authorization code exists.

What is deployed instead:

- The app runs YouVersion's own PKCE flow. `client_id` is the existing
  `YOUVERSION_APP_KEY`; no separate OAuth client exists or is needed.
- Registered redirect URI is `/functions/v1/yv-callback`, because **YouVersion only
  accepts https redirect URIs** -- a custom scheme is refused at registration. That
  function performs the state replay, then 302s to `dwell://auth-callback?code=...`,
  which `ASWebAuthenticationSession` catches. This avoids needing a domain we own,
  an apple-app-site-association file, and an Apple Team ID.
- The app exchanges the code for an `id_token` and posts it to
  `/functions/v1/youversion-signin`, which verifies it against their live JWKS, pins the
  audience to our client id, optionally checks the nonce, then finds or creates the user
  and returns a single-use `token_hash`. The client redeems that with `verifyOtp` for an
  ordinary Supabase session.
- Because the user gets a real `auth.users` row, `handle_new_auth_user` seeds their
  profile and every RLS policy downstream works unchanged.

**The `iss` claim on real tokens is `https://api.youversion.com/auth/token`** -- the
discovery document's value, NOT the `https://api.youversion.com` their sign-in docs
state. Both are accepted, because the two sources disagree and only real tokens settled
it. Pinning to the documented value alone would reject every live sign-in.

Verified 2026-09-28 with a real account: sign-in, consent, state replay, code issue,
token exchange, JWKS verification, session redemption, and an authenticated PostgREST
read under RLS.

Note: only HighlightsClient in YouVersion's own SDK requires authentication — Passages/Audio content calls are unauthenticated. This bridge exists purely to establish our own user identity, not as a prerequisite for reading Bible content.

---

# 3. Database

## 3.1 Schema (Postgres)

```sql
create type media_type as enum ('text', 'voice');
create type source_type as enum ('youversion_plan', 'custom');
create type day_status as enum ('open', 'threshold_met', 'complete', 'missed');
create type challenge_status as enum ('forming', 'active', 'paused', 'completed', 'abandoned', 'expired_incomplete');
create type insight_scope as enum ('day_instance', 'group_challenge');
create type insight_type as enum ('group_pulse', 'nudge', 'end_summary', 'fallback_recap', 'inactivity_prompt', 'weekly_recap');
create type day_frequency as enum ('daily', 'weekdays', 'three_per_week');

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
  day_count int not null,
  youversion_plan_id text,      -- null for custom "verse a day" challenges; set when based on a real YouVersion plan
  youversion_deep_link text,    -- optional tap-out to the full plan in the YouVersion app
  image_path text,              -- cover art: object key in the public plan-images bucket
  description text,             -- one or two sentences for the plan detail screen
  key_verse text,               -- verse body without quote marks; the client adds them
  key_verse_ref text,           -- human-readable reference for key_verse, e.g. Psalm 46:10
  listed boolean not null default true  -- in the picker; unlisted plans stay readable to members of a group on them
);

-- Per-day passage list for a plan. Seeded once by the mock PlanService (see 3.4), which stands in
-- for a future YouVersion plans endpoint. Source of truth for passage_ref when a new day_instance
-- is opened; day_instances copies from here. Passage TEXT is always fetched live from the real
-- bibles/passages endpoint using passage_ref; only this table of contents is mocked.
create table plan_days (
  plan_challenge_id uuid not null references plan_challenges(id) on delete cascade,
  day_index int not null,
  passage_ref text not null,
  title text,                   -- the day's theme line ("Stop", "Listen"), shown beside the passage
  primary key (plan_challenge_id, day_index)
);

-- The catalogue holds five plans: the two from the first redesign (When Life Gets Hard, The
-- Psalms: A Roadmap to Resilience), which carry no description and are UNLISTED since
-- 2026-10-03 (KAN-19) so the picker shows only finished plans, and the three the 02b
-- Plans screens define with full copy -- Be Still (3 days), Better Together (7) and Abide
-- (14). RLS hides an unlisted plan and its days from everyone except members of a group
-- already reading it, so the picker query filters on listed = true (a member's catalogue
-- read otherwise includes their own unlisted plan); create-group still accepts an unlisted
-- plan by id, which is how the demo seed and the test fixtures keep their 7-day arc on
-- When Life Gets Hard. Each plan's cover is drawn by scripts/make-plan-cover.py and committed under
-- assets/plan-images/ before being uploaded with the service role.

create table groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_challenge_id uuid not null references plan_challenges(id),
  catch_up_threshold_pct int not null default 50,  -- always 50 since 2026-10-03 (older groups updated by migration 44); custom thresholds are not supported and create-group ignores a supplied one. Kept as a column so the threshold math is unchanged
  auto_skip_after_days int not null default 3,
  frequency day_frequency not null default 'daily',   -- how often a new day may open
  timezone text not null default 'UTC',               -- whose weekend counts as the weekend
  challenge_status challenge_status not null default 'forming',
  invite_token text not null unique default translate(encode(gen_random_bytes(9), 'base64'), '+/', '-_'), -- base64url: 9 bytes = 12 chars, no padding, URL-safe for magic links
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
  opened_at timestamptz not null default now(), -- when this day became postable; drives the rolling 24h window, is_late, and advancement
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
  translated_text jsonb,          -- language-keyed translations ONLY
  ai_response text,               -- the personalized response from the generation step
  ai_response_translated jsonb,   -- the response, keyed by the language translated INTO; null when every group-mate reads the author's language
  language text not null,
  sentiment_tag text,
  moderation_status text not null default 'pending',
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
  target_user_id uuid references users(id) on delete cascade, -- null = group-wide (pulse, end summary); set = personal nudge
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
```

## 3.2 Triggers & Functions

Auth bridge — seeds a profile row the moment Supabase creates the auth user:

```sql
create or replace function public.handle_new_auth_user()
returns trigger as $$
begin
  insert into public.users (id, name, preferred_language, timezone)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', 'Friend'), 'en', 'UTC');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
```

check-day-threshold: the core gating logic. It fires on reflection *approval* (the UPDATE that sets moderation_status = 'approved'), not on the raw insert, so moderation always runs before a post can count. It counts only approved reflections, guards the member-count division against zero, and dispatches group-pulse only when its own call is the one that flips the day.

check_day_threshold also closes the challenge when everyone has posted on the final day (4.2 rule 3): it completes the day, flips the group to completed and dispatches end-of-challenge-summary, the same three writes open_ready_next_days makes at the 24h mark. The listing below shows the threshold half; see migration 43 for the completion half.
```sql
create or replace function public.check_day_threshold()
returns trigger as $$
declare
  v_group_id uuid;
  v_opened_at timestamptz;
  v_pct int;
  v_member_count int;
  v_posted_count int;
  v_flipped int;
begin
  select group_id, opened_at into v_group_id, v_opened_at
    from day_instances where id = new.day_instance_id;
  select catch_up_threshold_pct into v_pct from groups where id = v_group_id;

  -- members who had joined before this day opened; late joiners never change a past day's math
  select count(*) into v_member_count from group_members gm
    where gm.group_id = v_group_id and gm.joined_at <= v_opened_at;

  -- only APPROVED reflections count toward the gate; pending/flagged never do
  select count(*) into v_posted_count from reflections
    where day_instance_id = new.day_instance_id and moderation_status = 'approved';

  update day_instances set participation_count = v_posted_count
    where id = new.day_instance_id;

  if v_member_count > 0
     and (v_posted_count::float / v_member_count::float) * 100 >= v_pct then
    update day_instances set status = 'threshold_met'
      where id = new.day_instance_id and status = 'open';
    get diagnostics v_flipped = row_count;   -- 1 only for the call that actually flips it
    if v_flipped = 1 then                     -- guards generate-group-pulse against double-firing
      perform net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/generate-group-pulse',
        body := jsonb_build_object('day_instance_id', new.day_instance_id),
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'))
      );
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

-- fires on approval, not on the raw insert, so moderation always runs first
create trigger on_reflection_approved
  after update of moderation_status on reflections
  for each row
  when (new.moderation_status = 'approved' and old.moderation_status is distinct from 'approved')
  execute function public.check_day_threshold();
```

is_group_member: a SECURITY DEFINER helper that every group-scoped RLS policy calls. Because it runs with RLS off inside the function, a membership check on group_members never recurses (see Row-Level Security).

```sql
create or replace function public.is_group_member(p_group_id uuid)
returns boolean as $$
  select exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$ language sql security definer stable;
```

open_ready_next_days: advancement. Opens the next day once the current one is threshold_met AND has been open at least 24 hours (the "one per 24h" pacing). Run by pg_cron (5.2); pure SQL, no HTTP, so it is a plpgsql function rather than an Edge Function. It also completes the finished day and, on the final day, transitions the group to completed and fires end-of-challenge-summary. Both arguments are optional and pg_cron passes neither: p_now is the clock the 24h gate and the reading rhythm are judged against (the tests pin it), and p_group_id restricts the sweep to one group, which is how scripts/advance-day.sh moves a single group forward without touching any other group that happens to be due.

debug_advance_day / debug_rewind_day: the SQL behind /debug-day (1.1). Both are security definer, revoked from anon/authenticated, and granted only to service_role, so they are reachable solely through that Edge Function — which itself only exists when DEBUG_DAY_ENABLED is set. Advance reuses advance-day.sh's mechanics (backdate past the 24h gate, force threshold_met, run open_ready_next_days for that group alone, judging rest days as of the group's last reading day); rewind deletes the newest day_instance (reflections cascade) and reopens the previous one, or reopens the final day of a completed challenge (the end-summary insight row is left in place). debug_rewind_day takes the caller's user id and refuses to drop a day carrying anyone else's reflections, comments or reactions; reopening a completed challenge deletes the group's end_summary / fallback_recap insight, since end-of-challenge-summary never writes a second one.

my_groups(): every group the caller belongs to, the current one first (KAN-46). Returns id, name, challenge_status, plan_challenge_id, plan_title, plan_image_path, day_count, member_count, reflection_count (approved, whole group), created_at and last_activity_at (latest of created_at, latest opened day, latest approved post). Ordered non-terminal first, then last activity descending; the client takes the first row as the group to open into. Each challenge is its own group row (KAN-29 resolved), so finished groups accumulate here and feed the archived-challenges list. SECURITY DEFINER keyed on auth.uid() with no arguments, granted to authenticated only. The one-at-a-time rule itself is enforced by the one_ongoing_group trigger on group_members: before a membership is added it takes a per-person advisory lock and raises SQLSTATE DG409 if that person is in another group not completed/abandoned/expired_incomplete; create-group and join-group check first for a fast answer and map DG409 to the same 409 when two requests race.

my_continuations(): pending "same crew, new plan" invitations for the caller (KAN-50). One row per group that continues a finished group the caller was in, which the caller has not joined and which is still forming or active, newest first: group_id, name, continues_group_id, plan_title, plan_image_path, day_count, member_count, created_by, created_by_name, created_at. No invite token: accepting is join-group with { group_id }. SECURITY DEFINER keyed on auth.uid() with no arguments, granted to authenticated only. Declining is client-side for now. The previous members cannot read the new group under RLS, so Realtime does not reach them; the client re-reads on launch and on returning to the app.


```sql
create or replace function public.open_ready_next_days()
returns void as $$
declare
  r record;
  v_day_count int;
begin
  for r in
    select di.*, g.plan_challenge_id
    from day_instances di
    join groups g on g.id = di.group_id
    where g.challenge_status = 'active'
      and di.status = 'threshold_met'
      and di.opened_at <= now() - interval '24 hours'
      and not exists (select 1 from day_instances nx
                      where nx.group_id = di.group_id and nx.day_index = di.day_index + 1)
  loop
    select day_count into v_day_count from plan_challenges where id = r.plan_challenge_id;
    update day_instances set status = 'complete' where id = r.id;

    if r.day_index < v_day_count then
      insert into day_instances (group_id, day_index, date, passage_ref, opened_at, status)
      select r.group_id, r.day_index + 1, current_date, pd.passage_ref, now(), 'open'
      from plan_days pd
      where pd.plan_challenge_id = r.plan_challenge_id and pd.day_index = r.day_index + 1;
    else
      update groups set challenge_status = 'completed' where id = r.group_id;
      perform net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/end-of-challenge-summary',
        body := jsonb_build_object('group_id', r.group_id),
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'))
      );
    end if;
  end loop;
end;
$$ language plpgsql security definer;
```

preview-group — the public, unauthenticated RPC behind /preview-group above:

```sql
create or replace function public.preview_group(token text)
returns table (name text, plan_title text) as $$
  select g.name, pc.title
  from groups g
  join plan_challenges pc on pc.id = g.plan_challenge_id
  where g.invite_token = token
$$ language sql security definer stable;

grant execute on function public.preview_group(text) to anon;
```

## 3.3 Row-Level Security

Enabled on every table, deny-by-default. Representative policies below — the reflection lock, plus the two that are new since being explicit about the API surface:

```sql
alter table reflections enable row level security;

create policy "own reflection" on reflections
  for select using (user_id = auth.uid());

-- Unlock needs BOTH halves (MVP Spec 5): the group cleared the day, AND the caller's
-- own APPROVED reflection counts toward it. Posting alone is not enough, and a pending
-- or flagged post unlocks nothing. Implemented as public.is_reflection_unlocked(), which
-- comments and reactions reuse so they cannot outrun reading.
create policy "read unlocked reflections" on reflections
  for select using (public.is_reflection_unlocked(id));

-- No INSERT policy for authenticated: direct inserts are revoked so moderation can't be bypassed.
-- /submit-reflection uses the service role (which bypasses RLS) to insert as 'pending' and later flip to 'approved'.
revoke insert on reflections from authenticated;

-- New: comments, direct-write since MVP explicitly skips comment moderation
alter table comments enable row level security;

create policy "read comments in my groups" on comments
  for select using (
    exists (select 1 from reflections r
            join day_instances di on di.id = r.day_instance_id
            join group_members gm on gm.group_id = di.group_id
            where r.id = comments.reflection_id and gm.user_id = auth.uid())
  );

create policy "insert own comment" on comments
  for insert with check (
    user_id = auth.uid()
    and exists ( -- the target reflection must already be unlocked for me (I posted my own, approved, that day)
      select 1 from reflections r
      join day_instances di on di.id = r.day_instance_id
      where r.id = comments.reflection_id
        and public.is_group_member(di.group_id)
        and exists (select 1 from reflections mine
                    where mine.day_instance_id = r.day_instance_id
                      and mine.user_id = auth.uid()
                      and mine.moderation_status = 'approved')
    )
  );

-- New: users, own profile plus group-mates' names for member lists
alter table users enable row level security;

create policy "read own or group-mate profile" on users
  for select using (
    id = auth.uid()
    or exists (select 1 from group_members mine join group_members theirs
               on theirs.group_id = mine.group_id
               where mine.user_id = auth.uid() and theirs.user_id = users.id)
  );

create policy "update own profile" on users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- New: reactions, same unlock rule as comments
alter table reactions enable row level security;

create policy "read reactions in my groups" on reactions
  for select using (
    exists (select 1 from reflections r
            join day_instances di on di.id = r.day_instance_id
            where r.id = reactions.reflection_id and public.is_group_member(di.group_id))
  );

create policy "write own reaction" on reactions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
```

groups, group_members, day_instances, ai_insights, leaderboard_entries, and reactions all follow the same "caller is a member of this group" shape, but each expresses it by calling `is_group_member(<group_id column>)` rather than an inline EXISTS on group_members. That matters most for group_members' own SELECT policy: a policy on group_members that queries group_members inline causes infinite RLS recursion in Postgres, and because is_group_member is SECURITY DEFINER the lookup inside it runs with RLS off, which breaks the loop. (ai_insights additionally lets a personal nudge through when target_user_id = auth.uid().) Edge Functions use the service role key server-side only, never shipped to the client. Raw YouVersion tokens are never persisted, only Supabase's own session tokens.

## 3.4 Mock PlanService & Seed Plan

PlanService is a thin interface with two calls: getPlan(plan_id) returns metadata (id, title, day_count, youversion_plan_id, deep link), and getPlanDays(plan_id) returns the per-day list (day_index to passage_ref). For the MVP it is a mock: it returns the seeded plan below instead of calling YouVersion, because the Platform API has no plans endpoint yet (confirmed 9/21: it exposes bibles/passages, verse of the day, search, and highlights, but no plans or devotionals). At challenge setup the mock's day list is written into plan_days once; from then on the daily loop only reads plan_days, and passage text is always fetched live from the real bibles/passages endpoint using passage_ref. When YouVersion ships a plans endpoint, only these two calls get reimplemented and nothing downstream changes.

Design notes: a real YouVersion plan day can carry a devotional (text, image, audio, or video) plus one or more Scripture references; the Platform API cannot serve that devotional content, so the mock reduces each day to a single primary passage. plan_days is one passage per (plan, day) for the MVP; multi-reference days would need its primary key widened. passage_ref uses USFM passage ids, the same identifiers the real passages endpoint takes, so the values are already swap-ready.

Seed plan (create your own plan in YouVersion later and transcribe it the same way):

```sql
-- Mock plan for the MVP. Stands in for a future YouVersion plans endpoint.
insert into plan_challenges (id, title, source_type, day_count, youversion_plan_id, youversion_deep_link)
values (
  '00000000-0000-0000-0000-0000000000a1',
  'Anchored: A 7-Day Journey Through Hope',
  'youversion_plan',
  7,
  'mock-anchored-hope-7',
  'https://www.bible.com/reading-plans/mock-anchored-hope-7'
);

insert into plan_days (plan_challenge_id, day_index, passage_ref) values
  ('00000000-0000-0000-0000-0000000000a1', 1, 'HEB.6.19'),      -- an anchor for the soul
  ('00000000-0000-0000-0000-0000000000a1', 2, 'ISA.40.31'),     -- hope renews strength
  ('00000000-0000-0000-0000-0000000000a1', 3, 'ROM.5.3-5'),     -- suffering builds hope
  ('00000000-0000-0000-0000-0000000000a1', 4, 'LAM.3.22-23'),   -- mercies new every morning
  ('00000000-0000-0000-0000-0000000000a1', 5, 'ROM.8.28'),      -- God works for good
  ('00000000-0000-0000-0000-0000000000a1', 6, '1PE.3.15'),      -- give a reason for the hope you have
  ('00000000-0000-0000-0000-0000000000a1', 7, 'REV.21.4-5');    -- hope fulfilled, all things new
```

The exact USFM range syntax (e.g. ROM.5.3-5) should be confirmed against the passages endpoint on first call; single-verse and chapter ids (HEB.6.19, GEN.1) are known-good.

---

# 4. Business Logic / Domain Rules

## 4.1 Group Formation & Late Joins

- A group needs **2 members** to run and holds at most **7** (decided 2026-09-24). It sits in forming with just its creator; the second join activates it and opens Day 1. If it later drops below 2 -- today only via account deletion, since there is no leave flow -- it reverts to forming rather than continuing as a one-person challenge, where the threshold would be trivially met by the last member alone. The day rows survive, and the next join revives it through the ordinary path.
- A group holds at most **7 members** (decided 2026-09-24), enforced by a trigger on group_members rather than only in /join-group, so simultaneous joins cannot overshoot the cap. The 8th join returns 409; an existing member re-tapping their invite link is exempt and stays a no-op.
- A group is created in forming state. The creator picks the plan/challenge, frequency, and catch-up threshold solo — no group vote gates this.
- /join-group flips the group to active and creates the Day 1 day_instances row the moment membership hits 2.
- A member joining once the group is already active gets no backfilled history — no missed days, no penalty. They're eligible to post starting with whatever day is currently open.
- participation_count and the required threshold for a given day are computed against group_members whose joined_at is on/before that day's opened_at (a timestamptz, so there's no date-coercion or timezone bug), so a late joiner can't retroactively change what a past day needed.

## 4.2 Incomplete-Challenge Flow

1. A reflection counts toward its day only once it is approved (check-day-threshold fires on that approval, not on the raw insert). Still below catch_up_threshold_pct after approval means the day stays open. is_late is set at approval time: true if the approving moment is past opened_at + 24 hours (the member's rolling window; a late joiner's window starts at max(day.opened_at, their joined_at)).
2. Threshold met (even a day late) flips status to threshold_met retroactively, and everyone who already posted an approved reflection is unlocked in that same write. Only the call that actually flips the row dispatches generate-group-pulse, so it never double-fires.
3. Advancement is threshold-gated, paced AND on-rhythm. The next day opens only once the current day is threshold_met, has been open at least 24 hours, and today is a reading day for the group's frequency (daily: always; weekdays: Mon-Fri; three_per_week: Mon/Wed/Fri), judged in the group's own timezone. On a rest day the cleared day deliberately stays threshold_met rather than being completed, since completing it would drop it out of open_ready_next_days' own search and no next day would ever open. daily-cron-autoskip skips rest days too: a rest day is not a missed day, so the below-threshold counter does not move. open_ready_next_days (pg_cron, every 15 min) marks the cleared day complete, copies the next passage from plan_days into a fresh day_instances row with opened_at = now(), and on the final day transitions the group to completed and fires end-of-challenge-summary. This is the "one per 24h" rule: a group can't binge a whole plan in an afternoon, and it is not cut off at a hard server midnight either. **Completion has a second door (KAN-42, decided 2026-10-03):** when every member who was in the group when its final day opened has an approved reflection on it, check_day_threshold completes that day, sets the group to completed and dispatches end-of-challenge-summary at once, with no 24h wait, so a group that all finished sees it finished. The sweep cannot repeat that, since it only takes threshold_met days, and the summary is guarded by a unique index besides. A late joiner's post does not stand in for a founder's; someone who has left since the day opened neither counts nor holds the group open, as in the threshold math; and the group row is locked and re-checked before the flip, so a pause or end a member committed meanwhile is never overwritten.
4. If a day stays below threshold past its window, /daily-cron-autoskip is the sole writer of consecutive_below_threshold_count. Once per day it increments the counter for each active group's current open day that is still short, and when the counter hits the group's auto_skip_after_days it marks that day missed, opens the next day, and resets the counter to 0.
5. Zero total posts for 3 consecutive days makes /daily-cron-inactivity-check fire the Continue/Pause/End prompt once; it doesn't re-fire while pending. Continue resets the silence counter, Pause freezes advancement and nudges, End sets challenge_status = 'abandoned'.
6. expired_incomplete: a longer-horizon sweep in the same inactivity cron marks any group that is still 'active' or 'paused', has had no approved reflection for 14 days, and has not reached its final day, as expired_incomplete, then fires end-of-challenge-summary (which falls back to the lighter recap when there is little content). This is the MVP's concrete definition of "the challenge's time window elapsed," since a self-paced challenge has no hard clock.
7. Individual leaderboard scoring only ever reads a user's own reflection rows, never day_instances.status, so group-level skips, pauses, or expiry can't touch an individual's score.

---

# 5. Infrastructure

## 5.1 Environment Variables & Secrets

Client (Swift app — Info.plist / xcconfig, not committed):

- SUPABASE_URL, SUPABASE_ANON_KEY, YOUVERSION_APP_KEY

Supabase Edge Functions (supabase secrets set):

- OPENAI_API_KEY
- APNS_AUTH_KEY_P8 (base64-encoded .p8 contents), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_HOST (api.push.apple.com for TestFlight and App Store builds, api.sandbox.push.apple.com for builds run from Xcode), read by send-push
- SUPABASE_SERVICE_ROLE_KEY (auto-injected in deployed functions; set manually only for local dev)
- DEBUG_DAY_ENABLED ("true" to enable /debug-day; never set in production, where the endpoint must not exist)

Supabase Vault (for the in-database functions that call Edge Functions via pg_net):

- project_url and service_role_key, read inside check-day-threshold and open_ready_next_days from vault.decrypted_secrets, never hardcoded in the function body

Supabase Dashboard config (not code):

- MVP: a standard OAuth provider (Apple/Google) — client ID/secret and redirect URL
- Fast-follow: Custom OIDC Provider custom:youversion — issuer URL, client ID/secret, scopes

## 5.2 Scheduled Jobs (pg_cron)

| **Job** | **Schedule** |
| --- | --- |
| daily-cron-nudge | `*/15 * * * *` (every 15 min, to respect per-user local timezones) |
| open_ready_next_days (plpgsql, not an Edge Function) | `*/15 * * * *` (every 15 min, opens the next day promptly at the 24h mark) |
| daily-cron-autoskip | `15 0 * * *` (00:15 UTC daily) |
| daily-cron-inactivity-check | `30 0 * * *` (00:30 UTC daily) |
| weekly-cron-leaderboard | `0 0 * * 1` (Monday 00:00 UTC) |

## 5.3 Push Notifications (APNs)

**Delivery is live, and the in-app row stays the record.** The functions that decide who to nudge and what to say write the nudge as an ai_insights row (type 'nudge', target_user_id set) that the app renders, exactly as in the MVP; daily-cron-nudge then dispatches the same words to send-push, which is the single place that talks to Apple. A member with no token, or whose device Apple no longer knows, simply gets no push -- the nudge still exists for them in the app, so delivery can never be the reason a nudge is lost.

- Device tokens register client-side on first launch, written to users.push_token via the direct PostgREST update in the Auth flow (kept even while delivery is stubbed).
- Auth to Apple: a provider JWT auth key (.p8), not a certificate, doesn't expire, one key for all environments.
- send-push builds an ES256 provider JWT from the .p8 (`_shared/apns.ts`, cached for 55 minutes since Apple refuses tokens older than an hour) and POSTs to `https://<APNS_HOST>/3/device/<device_token>` with that JWT as bearer, APNS_BUNDLE_ID as the apns-topic header and `{ aps: { alert: { title, body }, sound } }` as the body. Deno's native fetch handles HTTP/2, no extra library.
- **Sandbox vs production endpoint:** a build installed from Xcode registers a sandbox token, which returns BadDeviceToken against api.push.apple.com; only TestFlight and App Store builds carry production tokens. The host is the APNS_HOST secret, so switching environments is one `supabase secrets set`. BadDeviceToken is deliberately NOT treated as a dead token, since it usually means the wrong host rather than a gone device.
- A 410 (Unregistered) response nulls out that user's push_token so dead tokens stop being retried. Every other refusal is logged and returned as delivered: false.

## 5.4 Project Setup — Who Does What

Manual, Mulero only — these need a real human account, no way around it:

1. Create the Supabase account + project at [supabase.com/dashboard](http://supabase.com/dashboard) (org, project name, region, DB password) — generates the Project URL, anon key, and service role key
2. Generate a Personal Access Token at [supabase.com/dashboard/account/tokens](http://supabase.com/dashboard/account/tokens), set it as SUPABASE_ACCESS_TOKEN locally — lets the CLI authenticate non-interactively so Claude Code never needs a browser login popup
3. In Database → Extensions, enable pg_cron and pg_net — both off by default; nothing in the scheduled jobs (5.2) or the check-day-threshold trigger's pg_net call works until these are on
4. In Authentication → Sign In / Providers, enable a standard provider (Sign in with Apple and/or Google) for the MVP — Dashboard config with the provider's client ID/secret. (Adding the YouVersion Custom OIDC provider, custom:youversion, is the fast-follow; see Section 2.)
5. Apple Developer Portal: create the APNs .p8 key, note the Key ID + Team ID
6. OpenAI: create the account, generate the API key

Scripted, Claude Code — once handed the access token + project ref:

1. supabase link --project-ref <ref> (no separate login needed with the access token set)
2. Write the Section 3 schema as a migration (supabase migration new init_schema, paste the SQL, supabase db push), including the pg_cron.schedule(...) calls for the four jobs in 5.2 in the same pass
3. Scaffold and deploy each function from Section 1's tables: supabase functions new <name>, write the code, supabase functions deploy <name>
4. supabase secrets set OPENAI_API_KEY=... APNS_AUTH_KEY_P8=... etc., using the values Mulero supplies

---

# 6. Resolved Design Decisions

- **Auth (MVP sequencing, decided 9/20)**: ship standard Supabase OAuth (Apple/Google) first so the core loop is unblocked; add YouVersion login as an option later via the Custom OIDC Provider (custom:youversion) + signInWithOAuth (see Auth above). When picking YouVersion up, verify against their actual dashboard: whether they publish an OIDC discovery doc, and whether their OAuth client issues a secret at all (fall back to manual OAuth2 config if not). Nothing else in this doc depends on which provider is live.
- **Push notifications**: live. Nudges are written as in-app ai_insights rows and pushed over raw APNs via send-push (5.3).
- **check-day-threshold execution model**: synchronous Postgres trigger that fires on reflection approval (not insert), counts only approved reflections, guards the member-count division, and dispatches the LLM-dependent group-pulse step via pg_net (triggers can't await external calls) only when its own call flips the day.
- **Day pacing**: advancement is threshold-gated and paced one-per-24h via open_ready_next_days (pg_cron). The rolling 24h window (day_instances.opened_at + 24h, per member) drives on-time vs is_late and nudge timing; timezone is used only to send nudges at humane local hours.
- **Moderation ordering**: reflections insert as 'pending' and are gated on the flip to 'approved', so flagged content can never count toward threshold or reach group-pulse. Direct client insert on reflections is revoked to enforce this.
- **API surface principle**: side-effect-free writes (comments, profile updates) go straight through PostgREST; anything with logic, moderation, or an external call gets an Edge Function.
- **Plans (mock for MVP, decided 9/21)**: the Platform API has no plans endpoint, so a plan is modeled as one passage per day in plan_days, seeded at setup by a mock PlanService that stands in for a future plans endpoint (see 3.4). plan_challenges carries youversion_plan_id and an optional deep link for tapping out to the full plan in the YouVersion app. Passage text is always fetched live from the real passages endpoint; only the plan's table of contents is mocked.