#!/usr/bin/env bash
# Moves a group on to its next day, now, for testing.
#
# Everything downstream of day advancement -- the stalled-group prompt, end_summary,
# the weekly recap, a multi-day Memories calendar -- otherwise takes a real day per day
# to reach, because a day opens 24 hours after the previous one opened.
#
# This does NOT change that rule. It backdates the group's current day past the 24h gate,
# marks it threshold_met, and runs the real sweep for that one group, so completion and
# the end-of-challenge transition happen exactly as they do in production. On a rest day
# for the group's rhythm the sweep is judged as of its last reading day instead, so a
# weekdays group can still be moved on a Saturday.
#
#   ./scripts/advance-day.sh "Demo: Unlocked"          # one day forward
#   ./scripts/advance-day.sh "Demo: Unlocked" 3        # three days forward
#   ./scripts/advance-day.sh --silent "Demo: Forming"  # backdate and leave the threshold
#                                                      # UNMET, for the no-engagement
#                                                      # walkthrough; nothing advances
#
# Needs SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN in .env. Deliberately a script
# rather than an endpoint: nothing that bypasses the pacing gate should be reachable from
# the app, in any build.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

SILENT=no
if [ "${1:-}" = "--silent" ]; then SILENT=yes; shift; fi
GROUP="${1:?usage: advance-day.sh [--silent] \"<group name or id>\" [times]}"
TIMES="${2:-1}"
[ "$SILENT" = yes ] && TIMES=1

# One statement through the Management API. It reports SQL and auth errors as a non-2xx
# status with a message body, which a bare `curl -s` would swallow; stop on the first so
# a step is never reported that did not happen.
sql() {
  local body
  body=$(python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1]}))' "$1" \
    | curl -sS --fail-with-body -X POST \
        "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
        -d @-) || { echo "query failed: $body" >&2; exit 1; }
  printf '%s' "$body"
}

# The name is user-supplied and the API takes no parameters, so quote it as a SQL literal
# (doubling single quotes) and resolve it to an id once; everything after uses the id.
SQ="'"; Q="'${GROUP//$SQ/$SQ$SQ}'"
FOUND=$(sql "
  with g as (
    select g.id, g.name, g.challenge_status,
           -- Today if it is a reading day for this group, else its most recent one.
           (select now() - make_interval(days => n) from generate_series(0, 6) n
             where public.day_opens_today(g.frequency, g.timezone,
                                          now() - make_interval(days => n), g.custom_days)
             order by n limit 1) as clock
      from groups g
     where g.name = $Q or g.id::text = $Q)
  select id, name, challenge_status, clock::text as clock,
         clock::date <> now()::date as rest_day
    from g;" | python3 -c '
import sys, json
rows = json.load(sys.stdin)
if len(rows) != 1:
    print(f"{len(rows)} groups match {sys.argv[1]!r}; pass the id", file=sys.stderr); sys.exit(1)
r = rows[0]
print(r["id"], r["name"], r["challenge_status"], r["clock"], r["rest_day"], sep="\t")' "$GROUP")
IFS=$'\t' read -r ID NAME STATUS CLOCK REST <<< "$FOUND"

if [ "$STATUS" != active ]; then
  echo "  $NAME is $STATUS; only an active group advances" >&2; exit 1
fi
if [ "$REST" = True ]; then
  echo "  today is a rest day for $NAME's rhythm; judging the sweep as of ${CLOCK%% *}"
fi

for i in $(seq 1 "$TIMES"); do
  # Backdate the newest day past the 24h gate and settle its threshold: met, so the sweep
  # acts on it, or with --silent unmet, so it does not -- even if members had already
  # cleared it, since the walkthrough is about a day nobody turned up for.
  if [ "$SILENT" = yes ]; then
    SETTLE="case when status = 'threshold_met' then 'open'::day_status else status end"
  else
    SETTLE="case when status = 'open' then 'threshold_met'::day_status else status end"
  fi
  SETTLED=$(sql "
    update day_instances
       set opened_at = '$CLOCK'::timestamptz - interval '25 hours', status = $SETTLE
     where group_id = '$ID'
       and day_index = (select max(day_index) from day_instances where group_id = '$ID')
    returning day_index, status;" | python3 -c '
import sys, json
rows = json.load(sys.stdin)
if not rows:
    print("the group has no day yet; has it started?", file=sys.stderr); sys.exit(1)
print(rows[0]["day_index"], rows[0]["status"])')
  read -r BEFORE DAY_STATUS <<< "$SETTLED"

  if [ "$SILENT" = yes ]; then
    [ "$DAY_STATUS" = open ] \
      || { echo "  day $BEFORE is $DAY_STATUS, so it cannot be left waiting" >&2; exit 1; }
    echo "  day $BEFORE of $NAME now opened 25h ago with its threshold unmet; the sweep will leave it"
    break
  fi
  [ "$DAY_STATUS" = threshold_met ] \
    || { echo "  day $BEFORE is $DAY_STATUS; nothing to advance" >&2; exit 1; }

  # The real sweep, pointed at this group alone so no other due group moves with it.
  sql "select public.open_ready_next_days('$CLOCK', '$ID');" > /dev/null

  NOW=$(sql "
    select max(d.day_index) as day, g.challenge_status
      from groups g join day_instances d on d.group_id = g.id
     where g.id = '$ID' group by g.challenge_status;" | python3 -c '
import sys, json; r = json.load(sys.stdin)[0]; print(r["day"], r["challenge_status"])')
  read -r AFTER CHALLENGE <<< "$NOW"

  if [ "$CHALLENGE" = completed ]; then
    echo "  step $i: $NAME finished day $BEFORE, its last; the challenge is complete"; break
  elif [ "$AFTER" -gt "$BEFORE" ]; then
    echo "  step $i: $NAME is now on day $AFTER"
  else
    echo "  step $i: $NAME is still on day $BEFORE; the sweep did not advance it" >&2; exit 1
  fi
done

echo "  the 15-minute sweep still runs normally; nothing about the 24h rule changed"
