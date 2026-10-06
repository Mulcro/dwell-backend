import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import type { Dispatch } from "../_shared/dispatch.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";

export const ALREADY_NUDGED = "You've already nudged the group today";

/**
 * How the pushes leave: `defer` runs them after the response is sent (the runtime's
 * waitUntil), so a slow Apple round-trip never holds the button.
 */
export interface NudgePush {
  dispatch: Dispatch;
  defer(work: Promise<unknown>): void;
}

/**
 * POST /nudge-group
 * { group_id } -> { sent }
 *
 * A member nudges the group-mates who haven't posted on the group's current day (KAN-63).
 * This is a person reaching out, separate from Eagle's AI nudge that the cron writes.
 *
 * Recipients: members who haven't posted an approved reflection on the current day, who
 * have a device, and who haven't switched nudges off -- never the sender. `sent` is how
 * many pushes went out; 0 is a fine answer, e.g. when everyone has posted.
 *
 * One nudge per sender per group per day, claimed in the database before anything is
 * sent: a second call that day is a 409, which also lets the button keep its state across
 * a reinstall. The caller must be a member, and the group must be active.
 */
export async function handleNudgeGroup(
  req: Request,
  db: SupabaseClient,
  push: NudgePush,
): Promise<Response> {
  const senderId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);
  const groupId = requireString(body, "group_id");

  const { data: membership, error: memberError } = await db
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", senderId)
    .maybeSingle();
  if (memberError) failed("membership", memberError);
  if (!membership) throw new HttpError(403, "Not a member of this group");

  const { data: group, error: groupError } = await db
    .from("groups")
    .select("name, challenge_status")
    .eq("id", groupId)
    .maybeSingle();
  if (groupError) failed("group", groupError);
  if (!group || group.challenge_status !== "active") {
    throw new HttpError(409, "This group isn't active, so there's no one to nudge");
  }

  const { data: day, error: dayError } = await db
    .from("day_instances")
    .select("id")
    .eq("group_id", groupId)
    .order("day_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (dayError) failed("day", dayError);
  if (!day) throw new HttpError(409, "This group hasn't started its first day yet");

  const recipients = await recipientsFor(db, groupId, day.id, senderId);

  // Claim today's nudge before sending anything. The unique key is the limit, so a second
  // tap -- even one landing at the same instant -- is refused here.
  const { error: claimError } = await db.from("group_nudges").insert({
    group_id: groupId,
    day_instance_id: day.id,
    sender_id: senderId,
    recipients: recipients.length,
  });
  if (claimError?.code === "23505") throw new HttpError(409, ALREADY_NUDGED);
  if (claimError) failed("nudge claim", claimError);

  const { data: sender } = await db
    .from("users")
    .select("name")
    .eq("id", senderId)
    .maybeSingle();
  const firstName = (sender?.name ?? "").trim().split(/\s+/)[0] || "Someone";

  push.defer(Promise.allSettled(recipients.map((userId) =>
    push.dispatch("send-push", {
      user_id: userId,
      title: group.name,
      body: `${firstName} is hoping you'll add your reflection today.`,
      thread_id: groupId,
      data: { type: "nudge", group_id: groupId, day_instance_id: day.id },
    })
  )));

  return json({ sent: recipients.length });
}

/**
 * Members who haven't posted an approved reflection on the day, have a device, and
 * haven't switched nudges off -- minus the sender.
 */
async function recipientsFor(
  db: SupabaseClient,
  groupId: string,
  dayId: string,
  senderId: string,
): Promise<string[]> {
  const { data: members, error } = await db
    .from("group_members")
    .select("user_id, users!inner(push_token, notification_prefs)")
    .eq("group_id", groupId);
  if (error) failed("members", error);

  const { data: posted, error: postedError } = await db
    .from("reflections")
    .select("user_id")
    .eq("day_instance_id", dayId)
    .eq("moderation_status", "approved");
  if (postedError) failed("reflections", postedError);
  const hasPosted = new Set((posted ?? []).map((r: { user_id: string }) => r.user_id));

  return (members ?? [])
    .filter((m: { user_id: string; users: unknown }) => {
      const user = m.users as {
        push_token: string | null;
        notification_prefs: Record<string, unknown> | null;
      };
      return m.user_id !== senderId &&
        !hasPosted.has(m.user_id) &&
        Boolean(user.push_token) &&
        user.notification_prefs?.nudge !== false;
    })
    .map((m: { user_id: string }) => m.user_id);
}

function failed(what: string, error: unknown): never {
  console.error(`nudge-group could not load the ${what}`, error);
  throw new HttpError(500, "Could not send the nudge");
}
