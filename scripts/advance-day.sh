#!/usr/bin/env bash
# Moves a group on to its next day, now, for testing.
#
# Everything downstream of day advancement -- the stalled-group prompt, end_summary,
# the weekly recap, a multi-day Memories calendar -- otherwise takes a real day per day
# to reach, because a day opens 24 hours after the previous one opened.
#
# This does NOT change that rule. It backdates the current day's opened_at so the
# existing every-15-minutes sweep treats it as due, and optionally clears the threshold
# so the sweep will act on it at all. The sweep is still what advances the group, so
# what you are testing is the real path, not a shortcut around it.
#
#   ./scripts/advance-day.sh "Demo: Unlocked"          # one day forward
#   ./scripts/advance-day.sh "Demo: Unlocked" 3        # three days forward
#   ./scripts/advance-day.sh --silent "Demo: Forming"  # backdate without meeting threshold,
#                                                      # for the no-engagement walkthrough
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

sql() {
  python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1]}))' "$1" \
    | curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-
}

for i in $(seq 1 "$TIMES"); do
  # Backdate the newest day past the 24h gate. Meeting the threshold is separate: with
  # --silent we leave it unmet, which is what the no-engagement walkthrough needs.
  THRESHOLD_CLAUSE=", status = case when status = 'open' then 'threshold_met'::day_status else status end"
  [ "$SILENT" = yes ] && THRESHOLD_CLAUSE=""

  sql "update day_instances d
          set opened_at = now() - interval '25 hours'$THRESHOLD_CLAUSE
         from groups g
        where g.id = d.group_id
          and (g.name = '$GROUP' or g.id::text = '$GROUP')
          and d.day_index = (select max(day_index) from day_instances x where x.group_id = g.id);" > /dev/null

  # Run the real sweep rather than inserting a day ourselves, so advancement, completion
  # and the end-of-challenge transition all happen exactly as they do in production.
  sql "select public.open_ready_next_days();" > /dev/null

  sql "select g.name, max(d.day_index) as day, count(*) as total
         from groups g join day_instances d on d.group_id = g.id
        where g.name = '$GROUP' or g.id::text = '$GROUP'
        group by g.name;" \
    | python3 -c "
import sys, json
rows = json.load(sys.stdin)
if not rows: print('  no group matched'); raise SystemExit(1)
r = rows[0]
print(f\"  step $i: {r['name']} is now on day {r['day']} ({r['total']} day instances)\")"
done

echo "  the 15-minute sweep still runs normally; nothing about the 24h rule changed"
