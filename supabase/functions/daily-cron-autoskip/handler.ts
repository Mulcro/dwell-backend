import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import type { Dispatch } from "../_shared/dispatch.ts";
import { json } from "../_shared/http.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shape of the joined select below; supabase-js cannot infer an embedded join. */
interface ShortDay {
  id: string;
  group_id: string;
  day_index: number;
  consecutive_below_threshold_count: number;
  last_autoskip_on: string | null;
  groups: {
    auto_skip_after_days: number;
    plan_challenge_id: string;
    frequency: string;
    timezone: string;
    custom_days: number[] | null;
  };
}

/**
 * pg_cron, daily 00:15 UTC. Service role only.
 *
 * The sole writer of consecutive_below_threshold_count. Once per day it increments the
 * counter for each active group's current open day that is still short, and when the
 * counter reaches the group's auto_skip_after_days it marks that day missed, opens the
 * next one, and resets the counter.
 */
export async function handleDailyCronAutoskip(
  req: Request,
  db: SupabaseClient,
  dispatch: Dispatch,
  serviceRoleKey: string | string[],
  now: Date = new Date(),
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const today = now.toISOString().slice(0, 10);
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();

  // Days still open past their 24h window, in groups that are actually running.
  const { data, error } = await db
    .from("day_instances")
    .select(
      "id, group_id, day_index, consecutive_below_threshold_count, last_autoskip_on, " +
        "groups!inner(auto_skip_after_days, challenge_status, plan_challenge_id, " +
        "frequency, timezone, custom_days)",
    )
    .eq("status", "open")
    .eq("groups.challenge_status", "active")
    .lt("opened_at", cutoff);

  if (error) {
    console.error("daily-cron-autoskip query failed", error);
    return json({ error: "Could not load days" }, 500);
  }

  const days = (data ?? []) as unknown as ShortDay[];

  let incremented = 0;
  let skipped = 0;

  for (const day of days) {
    // Already handled today: a retry must not advance the counter a second time.
    if (day.last_autoskip_on === today) continue;

    const group = day.groups;

    // A rest day is not a missed day. Skipping a weekend would both punish the group for
    // a day they were never meant to post on and open the next day off-rhythm, so leave
    // the whole group alone until its next reading day.
    const { data: opensToday } = await db.rpc("day_opens_today", {
      p_frequency: group.frequency,
      p_timezone: group.timezone,
      p_at: now.toISOString(),
      p_custom_days: group.custom_days,
    });
    if (opensToday === false) continue;

    const count = day.consecutive_below_threshold_count + 1;

    if (count >= group.auto_skip_after_days) {
      await db
        .from("day_instances")
        .update({
          status: "missed",
          consecutive_below_threshold_count: 0,
          last_autoskip_on: today,
        })
        .eq("id", day.id);

      await openNextDay(db, dispatch, day.group_id, day.day_index, group.plan_challenge_id);
      skipped++;
    } else {
      await db
        .from("day_instances")
        .update({ consecutive_below_threshold_count: count, last_autoskip_on: today })
        .eq("id", day.id);
      incremented++;
    }
  }

  return json({ incremented, skipped });
}

/** Opens the day after a skipped one, or ends the challenge if the plan is exhausted. */
async function openNextDay(
  db: SupabaseClient,
  dispatch: Dispatch,
  groupId: string,
  dayIndex: number,
  planChallengeId: string,
): Promise<void> {
  const { data: plan } = await db
    .from("plan_challenges")
    .select("day_count")
    .eq("id", planChallengeId)
    .maybeSingle();

  if (!plan || dayIndex >= plan.day_count) {
    // The plan ran out; open_ready_next_days is not going to advance a missed day, so
    // close the challenge here rather than leaving it stuck.
    //
    // This group reached the end the hard way, by skipping its final day rather than
    // clearing it, so it never passes through open_ready_next_days -- which is the only
    // other place a completion dispatches the summary. Without this call they would
    // finish to silence.
    const { data: closed } = await db
      .from("groups")
      .update({ challenge_status: "completed" })
      .eq("id", groupId)
      .neq("challenge_status", "completed")
      .select("id");

    // Only the call that actually closed it dispatches, so a retry cannot double-fire.
    if (closed && closed.length > 0) {
      await dispatch("end-of-challenge-summary", { group_id: groupId });
    }
    return;
  }

  const { data: planDay } = await db
    .from("plan_days")
    .select("passage_ref")
    .eq("plan_challenge_id", planChallengeId)
    .eq("day_index", dayIndex + 1)
    .maybeSingle();
  if (!planDay) return;

  const { error } = await db.from("day_instances").insert({
    group_id: groupId,
    day_index: dayIndex + 1,
    date: new Date().toISOString().slice(0, 10),
    passage_ref: planDay.passage_ref,
  });

  // 23505 = the next day already exists; nothing to do.
  if (error && error.code !== "23505") {
    console.error("daily-cron-autoskip could not open next day", error);
  }
}
