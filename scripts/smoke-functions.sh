#!/usr/bin/env bash
# Boots the Edge Functions and calls them over HTTP.
#
# The other suites import the handlers directly, so they never execute index.ts: the
# Deno.serve wiring, the env lookups, or the import map the edge runtime actually reads.
# A bare specifier that resolves fine for `deno test` can still fail to boot in the
# runtime, which is exactly how every function once shipped broken.
#
# Requires a running local stack (`supabase start`).
set -euo pipefail

API="${SUPABASE_URL:-http://127.0.0.1:54321}"
# The two keys below are the Supabase CLI's FIXED LOCAL DEVELOPMENT keys, printed by
# `supabase start` and identical in every CLI install. They are public by design, carry
# iss=supabase-demo and no project ref, and are only valid against 127.0.0.1. They are
# not credentials for any deployed project. Secret scanners flag them; this is why.
ANON="${SUPABASE_ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0}"
SERVICE="${SUPABASE_SERVICE_ROLE_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU}"
SUPABASE_BIN="${SUPABASE_BIN:-supabase}"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"; kill %1 2>/dev/null || true' EXIT

# submit-reflection reads this at boot; the smoke test never reaches a real AI call.
printf 'OPENAI_API_KEY=sk-smoke-placeholder\n' > "$workdir/fn.env"

echo "booting functions..."
"$SUPABASE_BIN" functions serve --env-file "$workdir/fn.env" > "$workdir/serve.log" 2>&1 &

fail() { echo "SMOKE FAIL: $*"; echo "--- serve log ---"; tail -30 "$workdir/serve.log"; exit 1; }

# The runtime compiles each function on first request, so poll until one boots.
booted=""
for _ in $(seq 1 45); do
  code=$(curl -s -o "$workdir/out" -w '%{http_code}' -X POST "$API/functions/v1/create-group" \
    -H "apikey: $ANON" -H 'Content-Type: application/json' -d '{}' || true)
  # 401 means the worker booted and rejected us, which is all we need here.
  if [ "$code" = "401" ]; then booted=yes; break; fi
  sleep 2
done
[ -n "$booted" ] || fail "no function booted (last code=${code:-none}, body=$(cat "$workdir/out" 2>/dev/null))"

email="smoke-$RANDOM-$$@example.test"
password="pw-$RANDOM-$$-abcdef"
curl -s -X POST "$API/auth/v1/admin/users" -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"$password\",\"email_confirm\":true}" > /dev/null

token=$(curl -s -X POST "$API/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$token" ] || fail "could not sign in the smoke user"

echo "create-group over HTTP..."
body=$(curl -s -X POST "$API/functions/v1/create-group" -H "apikey: $ANON" \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Crew","plan_challenge_id":"00000000-0000-0000-0000-0000000000a1"}')
group=$(echo "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("group_id",""))')
[ -n "$group" ] || fail "create-group did not return a group_id: $body"

echo "a user token must not reach a system function..."
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/functions/v1/daily-cron-autoskip" \
  -H "apikey: $ANON" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{}')
[ "$code" = "401" ] || fail "daily-cron-autoskip accepted a user token (HTTP $code)"

echo "the service role must reach it..."
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/functions/v1/daily-cron-autoskip" \
  -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" -H 'Content-Type: application/json' -d '{}')
[ "$code" = "200" ] || fail "daily-cron-autoskip refused the service role (HTTP $code)"

echo "debug-day does not exist while the debug secret is unset..."
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/functions/v1/debug-day" \
  -H "apikey: $ANON" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "{\"group_id\":\"$group\",\"action\":\"advance\"}")
[ "$code" = "404" ] || fail "debug-day answered while disabled (HTTP $code)"

echo "delete-account refuses without the confirmation..."
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/functions/v1/delete-account" \
  -H "apikey: $ANON" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{}')
[ "$code" = "400" ] || fail "delete-account deleted without a confirmation (HTTP $code)"

echo "delete-account erases the caller..."
code=$(curl -s -o "$workdir/out" -w '%{http_code}' -X POST "$API/functions/v1/delete-account" \
  -H "apikey: $ANON" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"confirm":"DELETE"}')
[ "$code" = "200" ] || fail "delete-account failed (HTTP $code, $(cat "$workdir/out"))"

curl -s -X DELETE "$API/rest/v1/groups?id=eq.$group" \
  -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" > /dev/null

# Fallback sweep. delete-account above should already have removed the user; this
# catches the case where it is the thing that is broken, since a leftover auth row
# changes member counts for any test that counts users.
smoke_user=$(curl -s "$API/auth/v1/admin/users?per_page=200" \
  -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
  | python3 -c "
import sys, json
users = json.load(sys.stdin).get('users', [])
print(next((u['id'] for u in users if u.get('email') == '$email'), ''))
")
if [ -n "$smoke_user" ]; then
  curl -s -X DELETE "$API/auth/v1/admin/users/$smoke_user" \
    -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" > /dev/null
fi

echo "SMOKE PASS"
