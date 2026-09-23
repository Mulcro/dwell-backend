import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, optionalInt, readJson, requireString } from "../_shared/http.ts";

/**
 * POST /create-group
 * { name, plan_challenge_id, catch_up_threshold_pct?, auto_skip_after_days? }
 *   -> { group_id, invite_token }
 *
 * Creates a group in `forming` plus the creator's membership row. The group stays
 * forming until someone joins; /join-group is what activates it and opens Day 1.
 */
export async function handleCreateGroup(req: Request, db: SupabaseClient): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  const name = requireString(body, "name");
  const planChallengeId = requireString(body, "plan_challenge_id");
  const thresholdPct = optionalInt(body, "catch_up_threshold_pct", 1, 100);
  const autoSkipAfterDays = optionalInt(body, "auto_skip_after_days", 1, 30);

  const { data: plan } = await db
    .from("plan_challenges")
    .select("id, day_count")
    .eq("id", planChallengeId)
    .maybeSingle();
  if (!plan) throw new HttpError(404, "Plan not found");

  // A plan missing its day list would let a group form and activate, and only fail when
  // Day 1 tried to open -- leaving an active challenge with no day and no way forward.
  // Refuse here, while there is still nothing to clean up.
  const { count: dayCount } = await db
    .from("plan_days")
    .select("day_index", { count: "exact", head: true })
    .eq("plan_challenge_id", planChallengeId);

  if ((dayCount ?? 0) !== plan.day_count) {
    console.error(
      `plan ${planChallengeId} has ${dayCount} plan_days but day_count ${plan.day_count}`,
    );
    throw new HttpError(422, "That plan is not ready to use yet");
  }

  const { data: group, error: groupError } = await db
    .from("groups")
    .insert({
      name,
      plan_challenge_id: planChallengeId,
      created_by: userId,
      ...(thresholdPct !== undefined ? { catch_up_threshold_pct: thresholdPct } : {}),
      ...(autoSkipAfterDays !== undefined ? { auto_skip_after_days: autoSkipAfterDays } : {}),
    })
    .select("id, invite_token")
    .single();

  if (groupError || !group) {
    console.error("create-group insert failed", groupError);
    throw new HttpError(500, "Could not create group");
  }

  const { error: memberError } = await db
    .from("group_members")
    .insert({ group_id: group.id, user_id: userId });

  if (memberError) {
    // A group whose creator is not a member is unreachable by everyone, including them.
    // Undo rather than leave it stranded.
    console.error("create-group member insert failed, rolling back", memberError);
    await db.from("groups").delete().eq("id", group.id);
    throw new HttpError(500, "Could not create group");
  }

  return json({ group_id: group.id, invite_token: group.invite_token }, 201);
}
