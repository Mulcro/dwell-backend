import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import type { Dispatch } from "../_shared/dispatch.ts";
import { json } from "../_shared/http.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SILENT_DAYS_BEFORE_PROMPT = 3;
const SILENT_DAYS_BEFORE_EXPIRY = 14;

/**
 * pg_cron, daily 00:30 UTC. Service role only.
 *
 * Two sweeps over the same silence measurement:
 *   - 3 consecutive silent days surfaces the Continue/Pause/End prompt, once. It does
 *     not re-fire while an answer is still pending.
 *   - 14 silent days on a challenge that never reached its final day marks it
 *     expired_incomplete and closes it out. This is the MVP's concrete definition of
 *     "the challenge's time window elapsed", since a self-paced challenge has no clock.
 */
export async function handleDailyCronInactivityCheck(
  req: Request,
  db: SupabaseClient,
  dispatch: Dispatch,
  serviceRoleKey: string | string[],
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - DAY_MS).toISOString();

  const { data: groups, error } = await db
    .from("groups")
    .select(
      "id, consecutive_silent_days, prompt_pending, last_inactivity_check_on",
    )
    .in("challenge_status", ["active", "paused"]);

  if (error) {
    console.error("daily-cron-inactivity-check query failed", error);
    return json({ error: "Could not load groups" }, 500);
  }

  let prompted = 0;
  let expired = 0;

  for (const group of groups ?? []) {
    // Already measured today: a retry must not inflate the silence count.
    if (group.last_inactivity_check_on === today) continue;

    const { data: days } = await db
      .from("day_instances")
      .select("id, day_index")
      .eq("group_id", group.id);
    const dayIds = (days ?? []).map((d: { id: string }) => d.id);

    const recent = dayIds.length > 0
      ? (await db
        .from("reflections")
        .select("id", { count: "exact", head: true })
        .in("day_instance_id", dayIds)
        .eq("moderation_status", "approved")
        .gte("created_at", since)).count ?? 0
      : 0;

    const silentDays = recent > 0 ? 0 : group.consecutive_silent_days + 1;

    await db
      .from("groups")
      .update({
        consecutive_silent_days: silentDays,
        last_inactivity_check_on: today,
      })
      .eq("id", group.id);

    if (
      silentDays >= SILENT_DAYS_BEFORE_EXPIRY &&
      await notAtFinalDay(db, group.id, days ?? [])
    ) {
      await db
        .from("groups")
        .update({
          challenge_status: "expired_incomplete",
          prompt_pending: false,
        })
        .eq("id", group.id);
      await dispatch("end-of-challenge-summary", { group_id: group.id });
      expired++;
      continue;
    }

    if (silentDays >= SILENT_DAYS_BEFORE_PROMPT && !group.prompt_pending) {
      await promptEveryMember(db, group.id);
      await db.from("groups").update({ prompt_pending: true }).eq(
        "id",
        group.id,
      );
      prompted++;
    }
  }

  return json({ prompted, expired });
}

/** A group that already reached its plan's last day has finished, not expired. */
async function notAtFinalDay(
  db: SupabaseClient,
  groupId: string,
  days: Array<{ day_index: number }>,
): Promise<boolean> {
  const { data: group } = await db
    .from("groups")
    .select("plan_challenges(day_count)")
    .eq("id", groupId)
    .maybeSingle();

  const dayCount = (group?.plan_challenges as { day_count?: number } | null)
    ?.day_count;
  if (!dayCount) return true;

  const highest = days.reduce((max, d) => Math.max(max, d.day_index), 0);
  return highest < dayCount;
}

/** The prompt goes to every member; whoever answers first settles it. */
async function promptEveryMember(
  db: SupabaseClient,
  groupId: string,
): Promise<void> {
  const { data: members } = await db
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId);

  const rows = (members ?? []).map((m: { user_id: string }) => ({
    group_id: groupId,
    target_user_id: m.user_id,
    scope: "group_challenge",
    type: "inactivity_prompt",
    content: "This challenge has been quiet for a few days. Keep going, pause, or end it?",
  }));

  if (rows.length === 0) return;

  const { error } = await db.from("ai_insights").insert(rows);
  if (error) {
    console.error("daily-cron-inactivity-check could not write prompts", error);
  }
}
