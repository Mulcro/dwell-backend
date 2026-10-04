# Dwell backend: general

Dwell's backend is Supabase: Postgres, Auth, Realtime, and Edge Functions (TypeScript/Deno). The client is a SwiftUI app and is not in this repo.

- `docs/backend_design.md` is the source of truth for schema, API surface, and business rules. Read the relevant section before changing behavior, and update the doc in the same change if the design shifts.
- Prefer the Supabase CLI (`supabase migration new`, `supabase db push`, `supabase functions deploy`) over dashboard edits, so everything is reproducible from the repo.
- Never read, print, or commit `.env` or any secret. Secrets go in `supabase secrets set` (Edge Functions) or Supabase Vault (in-database calls).
- The service role key is server-side only. It must never appear in client-facing code, logs, or responses.
- AI calls are tiered: a cheap/fast OpenAI model for classification, a mid-tier one for generation. Moderation uses the standalone OpenAI Moderation endpoint, not the main LLM call.
- Before finishing any change, run `deno task check` (fmt, lint, tests) and, when SQL changed, `supabase db lint` and `supabase test db`. CI enforces the same; fix failures, never disable a rule to pass.
- `supabase/functions/deno.json` is the import map the edge runtime reads. The root `deno.json` is
  for tasks and tooling only, and is invisible to a deployed function: a dependency added to one
  must be added to the other, or every function fails to boot.
- `./scripts/smoke-functions.sh` boots the functions over HTTP. Run it after touching any
  `index.ts`, dependency or import map, since the test suites import handlers directly and never
  execute the serving layer.
- Every Edge Function ships with a `*_test.ts` next to it (`Deno.test`). Every migration that adds logic or RLS ships with a pgTAP test in `supabase/tests/`. Test behavior (threshold math, moderation gating, RLS unlock rules), not implementation.
- Keep changes minimal: no new code beyond what the task requires.
- Commit messages are a single line stating the main purpose of the change. No body, no bullet list, and no trailers. Never add yourself as a co-author or contributor.
- Never push to `main`. Work on a branch and open a PR for review, even for a one-line change. The PR body may carry the detail that commit messages deliberately leave out.
- Push goes out over APNs from `send-push`, which only other functions call. A nudge is still written as an `ai_insights` row first (type `nudge`, `target_user_id` set); the push carries the same words and is best effort.
- Deploy a function from its branch when asked, but do not `supabase db push` a migration until the PR review on it is resolved: a pushed migration can no longer be amended, so a reviewer's correction to it has nowhere to go.
