---
paths:
  - "supabase/migrations/**/*.sql"
  - "supabase/seed.sql"
---

# Database and migrations

- Schema changes are new migration files (`supabase migration new <name>`). Never edit a migration that has already been pushed.
- Every table has RLS enabled, deny-by-default. A new table ships with its policies in the same migration.
- Group-scoped policies call `public.is_group_member(<group_id column>)`. Do not inline an `EXISTS` on `group_members` inside a `group_members` policy: it recurses infinitely.
- `reflections` has no client INSERT. Direct insert is revoked from `authenticated`, and all writes go through `/submit-reflection` with the service role so moderation always runs. Do not add an INSERT policy.
- Reflections count toward a day only when `moderation_status = 'approved'`. `check_day_threshold` fires on the UPDATE to `approved`, not on insert.
- `SECURITY DEFINER` functions must be `stable` where possible, must not take untrusted SQL, and must be granted only to the roles that need them (`preview_group` is the only one granted to `anon`).
- Read `project_url` and `service_role_key` from `vault.decrypted_secrets` in pg_net calls. Never hardcode them.
- `consecutive_below_threshold_count` is written only by `/daily-cron-autoskip`.
- Member-count math uses `group_members.joined_at <= day_instances.opened_at`, so late joiners never change a past day.
- Extensions `pg_cron` and `pg_net` are enabled manually in the dashboard. Migrations should assume they exist and not try to create them.
