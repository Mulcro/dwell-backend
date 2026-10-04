/**
 * One challenge at a time (KAN-46).
 *
 * Someone may start or join a group only once every group they already belong to has
 * ended. A finished group stays theirs -- that is what keeps past challenges reachable --
 * but it no longer holds them back.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http.ts";

/** The statuses a challenge never leaves. Anything else is still going. */
export const TERMINAL_STATUSES = ["completed", "abandoned", "expired_incomplete"];

export const ONGOING_GROUP_MESSAGE =
  "Your group's challenge is still going. Finish it or leave the group first.";

/**
 * Throws 409 if the user is in a group whose challenge has not ended. `except` is the
 * group being joined, so re-tapping an invite to a group you are already in stays the
 * no-op it has always been.
 */
export async function requireNoOngoingGroup(
  db: SupabaseClient,
  userId: string,
  except?: string,
): Promise<void> {
  const { data, error } = await db
    .from("group_members")
    .select("group_id, groups!inner(challenge_status)")
    .eq("user_id", userId);

  if (error) {
    console.error("could not check existing memberships", error);
    throw new HttpError(500, "Could not check your groups");
  }

  const ongoing = (data ?? []).filter((row: { group_id: string; groups: unknown }) => {
    const status = (row.groups as { challenge_status: string }).challenge_status;
    return row.group_id !== except && !TERMINAL_STATUSES.includes(status);
  });
  if (ongoing.length > 0) throw new HttpError(409, ONGOING_GROUP_MESSAGE);
}
