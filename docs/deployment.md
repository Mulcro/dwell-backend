# Deployment

> **Historical snapshot.** Counts and lists below describe the backend when this was written. The current state is in the [README](../README.md) and `docs/backend_design.md`.

Deployed 2026-09-23 to Supabase project `lcsyjslwhdzlfyegbaii`.

Base URL: `https://lcsyjslwhdzlfyegbaii.supabase.co`

## What is live

- 13 migrations: full schema, RLS on all 11 tables, triggers, advancement SQL, the
  seeded 7-day mock plan, and the Realtime publication.
- 10 Edge Functions.
- 5 pg_cron jobs (see design doc 5.2). **These are running now.**
- Vault holds `project_url` and `service_role_key`, used by `dispatch_edge_function`
  for database-initiated calls.

## Which key the client uses

This project has both legacy JWT keys and the newer `sb_*` keys, and they are not
interchangeable.

| Caller | Key | Notes |
| --- | --- | --- |
| iOS app | the **publishable** key (`sb_publishable_…`), or the legacy `anon` JWT | Safe to ship. RLS is the only thing protecting data, and it is enabled everywhere. |
| Edge Functions / cron / server | a **secret** key (`sb_secret_…`) | Never ships to a client. |

The functions accept any key listed in `SUPABASE_SERVICE_ROLE_KEY` or
`SUPABASE_SECRET_KEYS`. The legacy `service_role` JWT is **not** accepted on this
project, because Supabase injects the newer key into the function environment.

## API surface

Edge Functions, `POST {base}/functions/v1/<name>`, request and response shapes in
design doc 1.1:

| Endpoint | Auth |
| --- | --- |
| `create-group` | user session |
| `join-group` | user session |
| `submit-reflection` | user session |
| `group-challenge-action` | user session, must be a group member |
| `generate-group-pulse`, `end-of-challenge-summary`, `daily-cron-*`, `weekly-cron-leaderboard` | secret key only |

Everything else is PostgREST under `{base}/rest/v1/`, governed entirely by RLS
(design doc 1.3), plus the public `preview_group` RPC and two Realtime channels
(`day_instances`, `ai_insights`).

## Verified against the deployed project

Against the live project, with real OpenAI calls:

- `create-group`, `join-group` (activates the group and opens Day 1 from the plan),
  `group-challenge-action`.
- `submit-reflection` end to end, both `text` and `voice`: moderation passes, the
  reflection is approved, `sentiment_tag` is set, and `translated_text` carries a real
  translation into a group-mate's `preferred_language` plus the personal response.
- The approval fires `check_day_threshold`: the day flips to `threshold_met`,
  `participation_count` tracks approved reflections, and exactly one `group_pulse` is
  written however many people post.
- `generate-group-pulse` reached through a genuine pg_net dispatch from inside the
  database (HTTP 200).
- The unlock rule: before posting, a member sees no reflections; after posting, they see
  the whole day.
- RLS isolation for anonymous callers; system functions refuse a user token and accept a
  secret key.

## Known issues

1. **`.env` has a `sb_secret_...` key stored under `SUPABASE_ANON_KEY`.** That is a
   server-side key. If it is used as the app's anon key it grants full database access
   to every client, bypassing RLS entirely. It should be the publishable key.
2. **The group pulse can over-generalise.** It fires the moment the threshold is met,
   which may be a single reflection, but the prompt does not say how many it is
   summarising -- so it can write "one of you... whereas others" about one person. Worth
   passing the count into the prompt.

## Client contract

The API surface the SwiftUI app codes against lives in Notion, not this repo:
**GLOO Hackathon 2026 -> Client API Contract**
https://app.notion.com/p/3e5d36984c6e81faaecad797886ff45d
