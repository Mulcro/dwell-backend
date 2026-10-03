import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";

const ACTIONS = ["advance", "rewind"] as const;
type Action = typeof ACTIONS[number];

/**
 * POST /debug-day
 * { group_id, action: "advance" | "rewind" } -> { day_index, challenge_status }
 *
 * Debug-only time travel for the app's debug UI. Advancing backdates the current day
 * past the 24h gate, forces its threshold met, and runs the real sweep for this one
 * group; rewinding deletes the newest day and reopens the one before it, or reopens the
 * final day of a completed challenge. A rewind that would delete anyone else's
 * reflections is refused.
 *
 * The function answers 404 unless the DEBUG_DAY_ENABLED secret is "true", so a
 * production project that never sets it does not expose a pacing bypass.
 */
export async function handleDebugDay(
  req: Request,
  db: SupabaseClient,
  enabled: boolean,
): Promise<Response> {
  if (!enabled) throw new HttpError(404, "Not found");

  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  const groupId = requireString(body, "group_id");
  const action = requireString(body, "action") as Action;
  if (!ACTIONS.includes(action)) {
    throw new HttpError(400, `action must be one of: ${ACTIONS.join(", ")}`);
  }

  const { data: membership, error: memberError } = await db
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) {
    console.error("debug-day could not check membership", memberError);
    throw new HttpError(500, "Could not check membership");
  }
  if (!membership) throw new HttpError(403, "Not a member of this group");

  // Rewinding is told who asked, because it may only delete the caller's own content.
  const { data, error } = action === "advance"
    ? await db.rpc("debug_advance_day", { p_group_id: groupId })
    : await db.rpc("debug_rewind_day", { p_group_id: groupId, p_user_id: userId });
  if (error) {
    // Our own refusals are raised as P0001 with a message written for the tester
    // ("day 3 is open; nothing to advance"). Anything else is a failure, not a verdict,
    // and its text stays in the logs.
    if (error.code === "P0001") throw new HttpError(409, error.message);
    console.error("debug-day could not move the day", error);
    throw new HttpError(500, "Could not move the day");
  }

  return json(data);
}
