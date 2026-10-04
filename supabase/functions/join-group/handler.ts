import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";
import {
  ONGOING_GROUP_MESSAGE,
  ONGOING_GROUP_SQLSTATE,
  requireNoOngoingGroup,
} from "../_shared/membership.ts";

/**
 * POST /join-group
 * { invite_token } or { group_id } -> { group_id, challenge_status }
 *
 * Adds the caller to the group. The join that brings membership to 2 flips the group to
 * `active` and opens Day 1. Idempotent: re-joining returns the current state rather than
 * erroring, since the invite link can be tapped twice.
 *
 * `group_id` is the one-tap accept for "same crew, new plan" (KAN-50): allowed only when
 * the caller was a member of the finished group this one continues. Anything else
 * answers like an unknown invite, so ids cannot be probed. Every other rule is the same
 * as joining by code.
 */
export async function handleJoinGroup(
  req: Request,
  db: SupabaseClient,
): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  const group = body.invite_token !== undefined
    ? await groupByInvite(
      db,
      // Forgives how the code was typed -- lower case from a pasted link, and the spaces
      // or dashes people add reading one out. Must match preview_group's normalization
      // exactly, or a code could preview fine and then fail to join.
      normalizeInviteCode(requireString(body, "invite_token")),
    )
    : body.group_id !== undefined
    ? await groupContinuedByCaller(db, userId, requireString(body, "group_id"))
    : null;

  if (body.invite_token === undefined && body.group_id === undefined) {
    throw new HttpError(400, "invite_token or group_id is required");
  }
  if (!group) throw new HttpError(404, "Invite not found");

  if (
    group.challenge_status === "completed" ||
    group.challenge_status === "abandoned"
  ) {
    throw new HttpError(409, "This challenge has already ended");
  }

  // One challenge at a time (KAN-46). The group being joined is excluded, so tapping
  // the invite to a group you are already in stays a no-op.
  await requireNoOngoingGroup(db, userId, group.id);

  // on_conflict makes a second tap a no-op instead of a duplicate-key error.
  const { error: memberError } = await db
    .from("group_members")
    .upsert({ group_id: group.id, user_id: userId }, {
      onConflict: "group_id,user_id",
    });

  if (memberError) {
    // 23514 = the group-size trigger. The cap is enforced in the database, so this is
    // the authoritative answer rather than a count read a moment earlier.
    if (memberError.code === "23514") {
      throw new HttpError(409, "This group is full");
    }
    // Another join or create for this person landed first; the database is the authority.
    if (memberError.code === ONGOING_GROUP_SQLSTATE) {
      throw new HttpError(409, ONGOING_GROUP_MESSAGE);
    }
    console.error("join-group member insert failed", memberError);
    throw new HttpError(500, "Could not join group");
  }

  let status = group.challenge_status;

  if (status === "forming") {
    const { count } = await db
      .from("group_members")
      .select("user_id", { count: "exact", head: true })
      .eq("group_id", group.id);

    if ((count ?? 0) >= 2) {
      // Guarded on `forming` so two simultaneous joins cannot both activate the group.
      const { data: activated } = await db
        .from("groups")
        .update({ challenge_status: "active" })
        .eq("id", group.id)
        .eq("challenge_status", "forming")
        .select("id");

      status = "active";

      if (activated && activated.length > 0) {
        await openFirstDay(db, group.id, group.plan_challenge_id);
      }
    }
  }

  return json({ group_id: group.id, challenge_status: status });
}

type JoinableGroup = { id: string; plan_challenge_id: string; challenge_status: string };

async function groupByInvite(
  db: SupabaseClient,
  inviteToken: string,
): Promise<JoinableGroup | null> {
  const { data } = await db
    .from("groups")
    .select("id, plan_challenge_id, challenge_status")
    .eq("invite_token", inviteToken)
    .maybeSingle();
  return data;
}

/** The group, but only if it continues a finished group the caller was in. */
async function groupContinuedByCaller(
  db: SupabaseClient,
  userId: string,
  groupId: string,
): Promise<JoinableGroup | null> {
  const { data } = await db
    .from("groups")
    .select("id, plan_challenge_id, challenge_status, continues_group_id")
    .eq("id", groupId)
    .maybeSingle();
  if (!data?.continues_group_id) return null;

  const { data: wasMember } = await db
    .from("group_members")
    .select("user_id")
    .eq("group_id", data.continues_group_id)
    .eq("user_id", userId)
    .maybeSingle();
  return wasMember ? data : null;
}

/** Copies Day 1's passage out of the plan. The unique (group_id, day_index) key is the
 * backstop if two callers race this far. */
async function openFirstDay(
  db: SupabaseClient,
  groupId: string,
  planChallengeId: string,
): Promise<void> {
  const { data: planDay } = await db
    .from("plan_days")
    .select("passage_ref")
    .eq("plan_challenge_id", planChallengeId)
    .eq("day_index", 1)
    .maybeSingle();

  if (!planDay) {
    console.error("join-group: plan has no day 1", planChallengeId);
    throw new HttpError(500, "Plan is not set up correctly");
  }

  const { error } = await db.from("day_instances").insert({
    group_id: groupId,
    day_index: 1,
    date: new Date().toISOString().slice(0, 10),
    passage_ref: planDay.passage_ref,
  });

  // 23505 = another join already opened Day 1; that is success, not failure.
  if (error && error.code !== "23505") {
    console.error("join-group: could not open day 1", error);
    throw new HttpError(500, "Could not start the challenge");
  }
}

/** Codes are stored upper-case and alphanumeric; accept any spacing or casing of one. */
export function normalizeInviteCode(token: string): string {
  return token.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}
