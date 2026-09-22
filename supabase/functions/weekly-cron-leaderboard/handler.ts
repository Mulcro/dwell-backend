import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { json } from "../_shared/http.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * pg_cron, Monday 00:00 UTC. Service role only.
 *
 * participation_score is the count of the member's own APPROVED reflections in the week
 * that just ended. It reads only that member's rows and never day_instances.status, so a
 * group-level skip, pause or expiry can never reduce an individual's score.
 */
export async function handleWeeklyCronLeaderboard(
  req: Request,
  db: SupabaseClient,
  serviceRoleKey: string,
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const now = Date.now();
  const weekStartDate = new Date(now - WEEK_MS);
  const weekStart = weekStartDate.toISOString().slice(0, 10);

  const { data: groups, error } = await db
    .from("groups")
    .select("id")
    .in("challenge_status", ["active", "paused"]);

  if (error) {
    console.error("weekly-cron-leaderboard query failed", error);
    return json({ error: "Could not load groups" }, 500);
  }

  const rows: Array<Record<string, unknown>> = [];

  for (const group of groups ?? []) {
    const { data: days } = await db
      .from("day_instances")
      .select("id")
      .eq("group_id", group.id);
    const dayIds = (days ?? []).map((d: { id: string }) => d.id);

    const { data: members } = await db
      .from("group_members")
      .select("user_id")
      .eq("group_id", group.id);

    for (const member of members ?? []) {
      let score = 0;

      if (dayIds.length > 0) {
        const { count } = await db
          .from("reflections")
          .select("id", { count: "exact", head: true })
          .eq("user_id", member.user_id)
          .eq("moderation_status", "approved")
          .in("day_instance_id", dayIds)
          .gte("created_at", weekStartDate.toISOString());
        score = count ?? 0;
      }

      rows.push({
        group_id: group.id,
        week_start: weekStart,
        user_id: member.user_id,
        participation_score: score,
      });
    }
  }

  if (rows.length > 0) {
    // Upsert on the natural key, so a re-run recomputes rather than duplicating.
    const { error: upsertError } = await db
      .from("leaderboard_entries")
      .upsert(rows, { onConflict: "group_id,week_start,user_id" });

    if (upsertError) {
      console.error("weekly-cron-leaderboard upsert failed", upsertError);
      return json({ error: "Could not write leaderboard" }, 500);
    }
  }

  return json({ week_start: weekStart, entries: rows.length });
}
