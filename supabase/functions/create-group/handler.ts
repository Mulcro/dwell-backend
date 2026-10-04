import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, optionalInt, readJson, requireString } from "../_shared/http.ts";

const FREQUENCIES = [
  "daily",
  "weekdays",
  "three_per_week",
  "four_per_week",
  "custom",
];

/**
 * POST /create-group
 * { name, plan_challenge_id, auto_skip_after_days? }
 *   -> { group_id, invite_token }
 *
 * Creates a group in `forming` plus the creator's membership row. The group stays
 * forming until someone joins; /join-group is what activates it and opens Day 1.
 *
 * The unlock threshold is not configurable (decided 2026-10-03): half the group has to
 * post for a day to unlock, every group. A `catch_up_threshold_pct` in the body is
 * refused, so a client that still offers the choice finds out rather than silently
 * creating a group with a different rule from the one it showed.
 */
const THRESHOLD_PCT = 50;
export async function handleCreateGroup(
  req: Request,
  db: SupabaseClient,
): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  const name = requireString(body, "name");
  const planChallengeId = requireString(body, "plan_challenge_id");
  if (body.catch_up_threshold_pct !== undefined) {
    throw new HttpError(
      400,
      "catch_up_threshold_pct is no longer supported; the threshold is 50% for every group",
    );
  }
  const autoSkipAfterDays = optionalInt(body, "auto_skip_after_days", 1, 30);

  // Reading rhythm (design doc 4.1). Weekday boundaries are judged in the group's own
  // timezone, taken from the creator's device, so "no new days at the weekend" means
  // their weekend and not UTC's.
  const frequency = body.frequency === undefined ? "daily" : requireString(body, "frequency");
  if (!FREQUENCIES.includes(frequency)) {
    throw new HttpError(
      400,
      `frequency must be one of: ${FREQUENCIES.join(", ")}`,
    );
  }
  const timezone = body.timezone === undefined ? "UTC" : requireString(body, "timezone");
  if (!isValidTimezone(timezone)) {
    throw new HttpError(
      400,
      "timezone must be a valid IANA name, such as America/New_York",
    );
  }

  // custom carries its own day pattern; every other frequency has one built in, and
  // accepting a mask alongside them would leave two sources of truth disagreeing.
  const customDays = parseCustomDays(body.custom_days);
  if (frequency === "custom" && customDays === null) {
    throw new HttpError(
      400,
      "custom_days is required when frequency is custom",
    );
  }
  if (frequency !== "custom" && customDays !== null) {
    throw new HttpError(
      400,
      "custom_days is only allowed when frequency is custom",
    );
  }

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
      frequency,
      timezone,
      custom_days: customDays,
      catch_up_threshold_pct: THRESHOLD_PCT,
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
    console.error(
      "create-group member insert failed, rolling back",
      memberError,
    );
    await db.from("groups").delete().eq("id", group.id);
    throw new HttpError(500, "Could not create group");
  }

  return json({ group_id: group.id, invite_token: group.invite_token }, 201);
}

/** A timezone the database will also accept; a bad one would silently shift the rhythm. */
function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * ISO weekdays a custom group may open a day on: 1 = Monday ... 7 = Sunday.
 *
 * Returns null when absent. Duplicates are collapsed rather than rejected -- [1,1,3] is
 * a clumsy way of saying [1,3], not an error worth failing a group creation over.
 */
function parseCustomDays(value: unknown): number[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(
      400,
      "custom_days must be a non-empty array of weekdays",
    );
  }

  const days = [...new Set(value)];
  for (const day of days) {
    if (
      typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7
    ) {
      throw new HttpError(
        400,
        "custom_days must contain whole numbers from 1 (Monday) to 7 (Sunday)",
      );
    }
  }
  return (days as number[]).sort((a, b) => a - b);
}
