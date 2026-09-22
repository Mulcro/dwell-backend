import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import type { Dispatch } from "../_shared/dispatch.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";

const ACTIONS = ["continue", "pause", "end"] as const;
type Action = typeof ACTIONS[number];

/**
 * POST /group-challenge-action
 * { group_id, action: "continue" | "pause" | "end" } -> { challenge_status }
 *
 * The response to the inactivity prompt. Any member may answer -- the prompt goes to
 * everyone and the first reply settles it, so this is deliberately not creator-only.
 */
export async function handleGroupChallengeAction(
  req: Request,
  db: SupabaseClient,
  dispatch: Dispatch,
): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  const groupId = requireString(body, "group_id");
  const action = requireString(body, "action") as Action;
  if (!ACTIONS.includes(action)) {
    throw new HttpError(400, `action must be one of: ${ACTIONS.join(", ")}`);
  }

  const { data: membership } = await db
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) throw new HttpError(403, "Not a member of this group");

  const { data: group } = await db
    .from("groups")
    .select("challenge_status")
    .eq("id", groupId)
    .maybeSingle();
  if (!group) throw new HttpError(404, "Group not found");

  // A finished challenge cannot be restarted or re-ended from the prompt.
  if (["completed", "abandoned", "expired_incomplete"].includes(group.challenge_status)) {
    throw new HttpError(409, "This challenge has already ended");
  }

  const status = action === "continue" ? "active" : action === "pause" ? "paused" : "abandoned";

  const { error } = await db
    .from("groups")
    .update({
      challenge_status: status,
      // Answering clears the prompt either way; continuing also forgives the silence.
      prompt_pending: false,
      ...(action === "continue" ? { consecutive_silent_days: 0 } : {}),
    })
    .eq("id", groupId);

  if (error) {
    console.error("group-challenge-action update failed", error);
    throw new HttpError(500, "Could not update the challenge");
  }

  if (action === "end") {
    await dispatch("end-of-challenge-summary", { group_id: groupId });
  }

  return json({ challenge_status: status });
}
