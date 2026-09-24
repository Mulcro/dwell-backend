# Client API contract

Everything the SwiftUI app talks to. Verified against the deployed project, not
transcribed from the design doc.

Base URL: `https://lcsyjslwhdzlfyegbaii.supabase.co`
Key: the **publishable** key (`sb_publishable_…`). Never a `sb_secret_…` key — that
bypasses RLS entirely.

Every request carries `apikey: <publishable>`. Authenticated requests also carry
`Authorization: Bearer <user access token>`.

## Rules that will bite if missed

1. **Send `timezone` when creating a group.** It decides which local day it is for
   `weekdays` / `three_per_week`. Omitted, the group silently gets UTC.
2. **PATCH the user's own row right after first login**, setting `timezone` and
   `preferred_language`. The auth trigger only seeds `'UTC'` and `'en'` placeholders,
   and `preferred_language` is what reflections get translated into for group-mates.
3. **A locked day is the normal state, not an error.** Until the viewer posts an approved
   reflection, `GET /rest/v1/reflections` returns `[]` for that day. Render the locked
   state from an empty list.
4. **The leaderboard is empty until the first Monday 00:00 UTC.** A new group has no rows
   at all. Needs an empty state.
5. **Identity always comes from the token.** `user_id` in a body is either ignored or
   rejected with 403.

## Edge Functions — `POST {base}/functions/v1/<name>`

| Endpoint | Body | Success |
| --- | --- | --- |
| `create-group` | `{ name, plan_challenge_id, frequency?, timezone?, catch_up_threshold_pct?, auto_skip_after_days? }` | `201 { group_id, invite_token }` |
| `join-group` | `{ invite_token }` | `200 { group_id, challenge_status }` |
| `submit-reflection` | `{ day_instance_id, media_type, content?, transcript?, language }` | `200 { reflection_id, moderation_status }` |
| `group-challenge-action` | `{ group_id, action }` | `200 { challenge_status }` |

- `frequency`: `daily` (default) | `weekdays` | `three_per_week` (Mon/Wed/Fri).
- `media_type`: `text` uses `content`; `voice` uses `transcript` (transcribed on-device).
- `action`: `continue` | `pause` | `end`. Any member may answer.
- `moderation_status` comes back `approved` or `flagged`. **Flagged is a 200, not an
  error** — the reflection is saved but stays hidden and counts toward nothing.

Errors are `{ "error": "<message>" }` with a non-2xx status. Notable ones:
`401` not signed in · `403` not a member · `404` day/group/invite not found ·
`409` already posted today, or the day/challenge is closed · `422` the plan has no day
list · `502` the AI service is unavailable (nothing is saved — safe to retry).

## PostgREST — `{base}/rest/v1/…`

RLS does all the access control; there is no server code on these.

| Resource | Ops | Notes |
| --- | --- | --- |
| `plan_challenges`, `plan_days` | select | Catalogue for the plan picker. Any signed-in user. |
| `groups` | select | Only groups you belong to. |
| `group_members` | select | Your groups' rosters. Count gives the Y in "X of Y posted". |
| `day_instances` | select | `participation_count` is the X. `status`: open / threshold_met / complete / missed. |
| `reflections` | **select only** | Own always; others' only once yours is approved for that day. Insert is revoked — use `submit-reflection`. |
| `comments` | select, insert | Only on a reflection already unlocked for you. |
| `reactions` | select, insert, delete | Same rule. One row per (reflection, user, emoji). |
| `ai_insights` | select | Group-wide insights, plus nudges targeted at you. |
| `leaderboard_entries` | select | Your groups. |
| `users` | select, update | Own row, plus group-mates' for display names. |

Public, no login — the in-browser invite preview:

```
POST {base}/rest/v1/rpc/preview_group   { "token": "<invite_token>" }
  -> [{ "name": "...", "plan_title": "..." }]   (empty array if unknown)
```

## Realtime

Subscribe to `postgres_changes`, filtered `group_id=eq.<id>`:

- **`day_instances`** — `participation_count` and `status` changes drive the live
  "X of Y posted" indicator and the unlock moment.
- **`ai_insights`** — inserts surface nudges, the group pulse and end summaries.

`reflections` is deliberately **not** published: postgres_changes cannot redact columns,
so a subscription would hand over content the viewer has not earned. The content-free
"someone just posted" signal rides on `day_instances.participation_count` instead.

## Insight types

`group_pulse` (day's themes, once the day unlocks) · `nudge` (personal, `target_user_id`
set) · `inactivity_prompt` (the Continue/Pause/End question) · `end_summary` /
`fallback_recap` (challenge over).

Push is stubbed for the MVP: nudges are `ai_insights` rows rendered in-app, not APNs.
