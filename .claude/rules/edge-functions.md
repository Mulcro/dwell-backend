---
paths:
  - "supabase/functions/**/*.ts"
---

# Edge Functions

- Runtime is Deno with TypeScript. Use native `fetch`, and import via `npm:` or `jsr:` specifiers pinned to a version.
- Only add an Edge Function when a write has logic, moderation, or an external call. Side-effect-free writes (profile updates) go through PostgREST with RLS instead. Replies are not one of those any more: they carry audio and images, so they go through `submit-comment` and direct insert is revoked.
- Client-facing functions require a valid Supabase session unless the design doc says otherwise. Verify the caller from the JWT, and never trust a `user_id` in the request body.
- System-triggered functions (`generate-group-pulse`, `daily-cron-*`, `weekly-cron-leaderboard`, `end-of-challenge-summary`) are invoked with the service role only. Reject any other caller.
- Use the service-role client only where RLS must be bypassed (for example inserting reflections). Prefer a client scoped to the caller's JWT elsewhere.
- Moderation runs before anything else in `/submit-reflection`. Flagged content stays hidden and must never reach threshold math, group pulse, or the LLM.
- `generate-group-pulse` reads approved reflections only.
- Functions triggered by cron or pg_net must be idempotent, since they can be retried or double-invoked.
- Return JSON with the shapes in the design doc. Errors use a non-2xx status and `{ "error": "<message>" }`, with no stack traces or upstream API bodies.
- Read secrets from `Deno.env.get(...)` and fail fast if one is missing. Never log secret values or user reflection content.
