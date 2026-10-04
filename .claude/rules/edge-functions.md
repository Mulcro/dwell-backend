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
- **Optional work goes after the core write, and never makes the job depend on its config.** A cron's reason to exist (scores, counters, advancement) is persisted first; AI calls, pushes and other courtesies run afterwards, bounded, with their failures logged and swallowed. If the courtesy needs a secret the job did not need before, read it with `Deno.env.get` and skip the courtesy when it is absent; `requireEnv` is only for what the job cannot run without.
- **One definition of a period per function.** When a job selects content and computes counts for "this week" or "this challenge", both use the same window and the same filter (the leaderboard and its recap both mean "posted in the window"). Two windows in one function will disagree the first time someone posts late.
- **Uniqueness is a constraint, not a check.** A "write this once" rule (one summary per challenge, one recap per week, one pulse per day) is enforced by a unique index; the function may pre-check to save work, but it treats `23505` from the insert as the real verdict and reports it, never as a 500. Crons overlap and pg_net retries, so check-then-insert in a function is a race.
- **Model tier follows the output, not the branch.** Anything written for a person to read uses `GENERATE_MODEL`, including fallbacks and short closing notes. `CLASSIFY_MODEL` is for classification only. Copying a prompt from an older branch does not carry its model choice.
- **Thresholds change tone, not structure.** If a card has a headline and member lines, any material at all produces them; low material changes the prose instruction, never whether the structure is there. A client that was promised fields should not get nulls because a count fell under a number chosen for a different reason.
- **Before opening a PR, read the diff as the reviewer will:** what happens if this runs twice at once; what is lost if the slow part stalls or its config is missing; do two places that describe the same period agree; which model writes each piece of prose; which promised field can come back empty.
