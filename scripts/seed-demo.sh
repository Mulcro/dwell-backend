#!/usr/bin/env bash
# Puts the deployed project into known demo states.
#
#   ./scripts/seed-demo.sh          create the demo users and groups
#   ./scripts/seed-demo.sh clean    remove everything it created
#
# Creates three users (demo-alice / demo-bob / demo-carol, password below) and four
# groups, one parked in each state a demo needs to show. Reads credentials from .env.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

API="https://${SUPABASE_PROJECT_REF}.supabase.co"
A="$SUPABASE_ANON_KEY"; S="$SUPABASE_SERVICE_ROLE_KEY"
PLAN="00000000-0000-0000-0000-0000000000a1"
PASSWORD="dwell-demo-2026"

sql() { python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1]}))' "$1" \
  | curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-; }

if [ "${1:-}" = "clean" ]; then
  sql "delete from groups where name like 'Demo:%';" > /dev/null
  sql "delete from auth.users where email like 'demo-%@dwell.test';" > /dev/null
  echo "demo data removed"; exit 0
fi

# --- users -------------------------------------------------------------------
declare -A TOK
for who in alice bob carol; do
  email="demo-$who@dwell.test"
  curl -s -X POST "$API/auth/v1/admin/users" -H "apikey: $S" -H "Authorization: Bearer $S" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"email_confirm\":true,\"user_metadata\":{\"name\":\"${who^}\"}}" > /dev/null || true
  tok=$(curl -s -X POST "$API/auth/v1/token?grant_type=password" -H "apikey: $A" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
  TOK[$who]=$tok
done

post() { curl -s -X POST "$API/functions/v1/$1" -H "apikey: $A" -H "Authorization: Bearer $2" \
  -H 'Content-Type: application/json' -d "$3"; }
jq_() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }

make_group() { # name, creator, extra-json -> "group_id invite_token"
  post create-group "${TOK[$2]}" "{\"name\":\"$1\",\"plan_challenge_id\":\"$PLAN\"$3}" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["group_id"], d["invite_token"])'
}
day_of() { curl -s "$API/rest/v1/day_instances?select=id&group_id=eq.$1&order=day_index.desc&limit=1" \
  -H "apikey: $A" -H "Authorization: Bearer ${TOK[alice]}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"] if d else "")'; }
reflect() { post submit-reflection "${TOK[$1]}" \
  "{\"day_instance_id\":\"$2\",\"media_type\":\"text\",\"content\":\"$3\",\"language\":\"en\"}" > /dev/null; }

echo "users: demo-alice / demo-bob / demo-carol @dwell.test   password: $PASSWORD"
echo

# 1. FORMING -- created, nobody has joined, invite link ready to demo.
read -r g1 inv1 < <(make_group "Demo: Forming" alice "")
echo "forming          group=$g1  invite=$inv1"

# 2. BELOW THRESHOLD -- three members at 100%, only one has posted.
read -r g2 inv2 < <(make_group "Demo: Below threshold" alice ",\"catch_up_threshold_pct\":100")
post join-group "${TOK[bob]}" "{\"invite_token\":\"$inv2\"}" > /dev/null
post join-group "${TOK[carol]}" "{\"invite_token\":\"$inv2\"}" > /dev/null
# Everyone must predate the day, or late joiners are excluded from its maths.
sql "update day_instances set opened_at = now() where group_id='$g2';" > /dev/null
reflect alice "$(day_of "$g2")" "Only I have posted so far."
echo "below threshold  group=$g2   (alice posted, day still locked)"

# 3. UNLOCKED -- both posted, day cleared, group pulse written.
read -r g3 inv3 < <(make_group "Demo: Unlocked" alice "")
post join-group "${TOK[bob]}" "{\"invite_token\":\"$inv3\"}" > /dev/null
d3=$(day_of "$g3")
reflect alice "$d3" "The anchor image steadied me through a hard week."
reflect bob "$d3" "I keep coming back to the word hope here."
echo "unlocked         group=$g3   (both posted, pulse generated)"

# 4. COMPLETED -- walked to the end of the plan, summary written.
read -r g4 inv4 < <(make_group "Demo: Completed" alice "")
post join-group "${TOK[bob]}" "{\"invite_token\":\"$inv4\"}" > /dev/null
for _ in $(seq 1 7); do
  d=$(day_of "$g4"); [ -n "$d" ] || break
  reflect alice "$d" "Reflection for this day."
  sql "update day_instances set opened_at = now() - interval '25 hours' where id='$d';" > /dev/null
  sql "select public.open_ready_next_days();" > /dev/null
done
curl -s -X POST "$API/functions/v1/end-of-challenge-summary" -H "apikey: $S" \
  -H "Authorization: Bearer $S" -H 'Content-Type: application/json' -d "{\"group_id\":\"$g4\"}" > /dev/null
echo "completed        group=$g4   (7 days cleared, summary written)"
echo
echo "run './scripts/seed-demo.sh clean' to remove all of it"
