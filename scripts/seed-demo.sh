#!/usr/bin/env bash
# Puts the deployed project into known demo states.
#
#   ./scripts/seed-demo.sh          create the demo accounts and groups
#   ./scripts/seed-demo.sh clean    remove everything it created
#
# One account per state, so the demo is "sign in as X to show state X" rather than
# hunting for the right group: PostgREST does not guarantee row order, so an account in
# several groups lands somewhere different between launches.
#
# RE-RUN THIS SHORTLY BEFORE DEMOING. The crons keep working on seeded groups -- after a
# few days the inactivity sweep raises the Continue/Pause/End prompt and auto-skip moves
# the days on, so the states stop matching their names.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

API="https://${SUPABASE_PROJECT_REF}.supabase.co"
A="$SUPABASE_ANON_KEY"; S="$SUPABASE_SERVICE_ROLE_KEY"
PLAN="00000000-0000-0000-0000-0000000000a1"
PASSWORD="dwell-demo-2026"
TZ_DEMO="${DEMO_TIMEZONE:-America/Los_Angeles}"
# The account that will be used for a live Google sign-in, so it lands on a real feed
# instead of an empty "Start or Join" screen. Must already exist (sign in once first).
LIVE_ACCOUNT="${DEMO_LIVE_ACCOUNT:-mulero.alamou@gmail.com}"

sql() { python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1]}))' "$1" \
  | curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-; }

if [ "${1:-}" = "clean" ]; then
  sql "delete from groups where name like 'Demo:%';" > /dev/null
  sql "delete from auth.users where email like 'demo-%@dwell.test';" > /dev/null
  echo "demo data removed"; exit 0
fi

# Start from a clean slate so re-running is always correct rather than additive.
sql "delete from groups where name like 'Demo:%';" > /dev/null

declare -A TOK
user() { # email-local-part -> token
  local email="demo-$1@dwell.test"
  curl -s -X POST "$API/auth/v1/admin/users" -H "apikey: $S" -H "Authorization: Bearer $S" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"email_confirm\":true,\"user_metadata\":{\"name\":\"${1%%-*}\"}}" > /dev/null || true
  TOK[$1]=$(curl -s -X POST "$API/auth/v1/token?grant_type=password" -H "apikey: $A" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')
  [ -n "${TOK[$1]}" ] || { echo "could not sign in demo-$1"; exit 1; }
}

post() { curl -s -X POST "$API/functions/v1/$1" -H "apikey: $A" -H "Authorization: Bearer $2" \
  -H 'Content-Type: application/json' -d "$3"; }

make_group() { # display-name owner extra-json -> "group_id invite_token"
  post create-group "${TOK[$2]}" \
    "{\"name\":\"$1\",\"plan_challenge_id\":\"$PLAN\",\"timezone\":\"$TZ_DEMO\"$3}" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["group_id"], d["invite_token"])'
}
current_day() { curl -s "$API/rest/v1/day_instances?select=id&group_id=eq.$1&order=day_index.desc&limit=1" \
  -H "apikey: $S" -H "Authorization: Bearer $S" \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d[0]["id"] if isinstance(d,list) and d else "")'; }
reflect() { post submit-reflection "${TOK[$1]}" \
  "{\"day_instance_id\":\"$2\",\"media_type\":\"text\",\"content\":\"$3\",\"language\":\"en\"}" > /dev/null; }

echo "accounts (password: $PASSWORD)"

# ---------------------------------------------------------------- 1. FORMING
user forming
read -r g1 inv1 < <(make_group "Demo: Forming" forming "")
echo "  demo-forming@dwell.test    -> Demo: Forming        invite=$inv1"

# -------------------------------------------------------- 2. BELOW THRESHOLD
# Three members and only the owner has posted: one of three is under the fixed 50%
# threshold, so the day stays locked. The two fillers exist only to make up the numbers
# and belong to no other group.
user locked; user locked-b; user locked-c
read -r g2 inv2 < <(make_group "Demo: Below threshold" locked "")
post join-group "${TOK[locked-b]}" "{\"invite_token\":\"$inv2\"}" > /dev/null
post join-group "${TOK[locked-c]}" "{\"invite_token\":\"$inv2\"}" > /dev/null
# Everyone must predate the day, or late joiners are excluded from its maths.
sql "update day_instances set opened_at = now() where group_id='$g2';" > /dev/null
reflect locked "$(current_day "$g2")" "I posted, but we are still waiting on the others."
echo "  demo-locked@dwell.test     -> Demo: Below threshold (day locked)"

# --------------------------------------------------------------- 3. UNLOCKED
user unlocked; user unlocked-b
read -r g3 inv3 < <(make_group "Demo: Unlocked" unlocked "")
post join-group "${TOK[unlocked-b]}" "{\"invite_token\":\"$inv3\"}" > /dev/null
d3=$(current_day "$g3")
reflect unlocked "$d3" "The anchor image steadied me through a hard week."
reflect unlocked-b "$d3" "I keep coming back to the word hope here."
echo "  demo-unlocked@dwell.test   -> Demo: Unlocked        (day cleared, pulse written)"

# -------------------------------------------------------------- 4. COMPLETED
user completed; user completed-b
read -r g4 inv4 < <(make_group "Demo: Completed" completed "")
post join-group "${TOK[completed-b]}" "{\"invite_token\":\"$inv4\"}" > /dev/null
for _ in $(seq 1 7); do
  d=$(current_day "$g4"); [ -n "$d" ] || break
  reflect completed "$d" "Reflection for this day."
  sql "update day_instances set opened_at = now() - interval '25 hours' where id='$d';" > /dev/null
  sql "select public.open_ready_next_days();" > /dev/null
done
curl -s -X POST "$API/functions/v1/end-of-challenge-summary" -H "apikey: $S" \
  -H "Authorization: Bearer $S" -H 'Content-Type: application/json' -d "{\"group_id\":\"$g4\"}" > /dev/null
echo "  demo-completed@dwell.test  -> Demo: Completed       (7 days, summary written)"

# ------------------------------- the live sign-in account joins the unlocked group
# Added with a backdated join and an approved reflection, so the feed is actually open
# for whoever signs in with Google on stage rather than showing the locked state.
LIVE_ID=$(sql "select id from auth.users where email = '$(echo "$LIVE_ACCOUNT" | sed "s/'/''/g")';" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"] if isinstance(d,list) and d else "")')
if [ -n "$LIVE_ID" ]; then
  sql "insert into group_members (group_id, user_id, joined_at)
       values ('$g3','$LIVE_ID', now() - interval '1 hour')
       on conflict do nothing;
       insert into reflections (user_id, day_instance_id, media_type, content, language, moderation_status)
       values ('$LIVE_ID','$d3','text','Grateful to be reading with you all today.','en','approved')
       on conflict do nothing;" > /dev/null
  echo "  $LIVE_ACCOUNT -> Demo: Unlocked (live sign-in lands on a real feed)"
else
  echo "  NOTE: $LIVE_ACCOUNT has no account yet. Sign in with Google once, then re-run."
fi

# ---------------------------------------------------------------- settle state
# The inactivity sweep and auto-skip have been running against these groups since the
# last seed; clear what they left behind and mark them handled for today so a demo run
# straight after seeding is not disturbed.
sql "update groups
        set prompt_pending = false,
            consecutive_silent_days = 0,
            last_inactivity_check_on = current_date
      where name like 'Demo:%';
     update day_instances d
        set last_autoskip_on = current_date
       from groups g
      where g.id = d.group_id and g.name like 'Demo:%';
     delete from ai_insights
      where type = 'inactivity_prompt'
        and group_id in (select id from groups where name like 'Demo:%');" > /dev/null

# ------------------------------------------------------------- demo languages
# A predictable language per account, so the bilingual part of the demo is repeatable
# rather than something to discover live. demo-unlocked-b reads French, which puts a
# French speaker in the one group whose day is unlocked -- the screen where translated
# reflections, replies and the group pulse are all visible at once.
#
# Set explicitly rather than left to the device locale: the client seeds this field from
# the phone, so without this the demo's languages depend on which phone is in your hand.
sql "update users set preferred_language = 'en'
      where id in (select id from auth.users where email like 'demo-%@dwell.test');
     update users set preferred_language = 'fr'
      where id in (select id from auth.users where email = 'demo-unlocked-b@dwell.test');" > /dev/null

echo
echo "demo-unlocked-b reads French, so Demo: Unlocked shows translation end to end"
echo "re-run this shortly before demoing; the crons drift the states over a few days"
