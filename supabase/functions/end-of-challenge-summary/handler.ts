import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";
import { type Ai, CLASSIFY_MODEL, GENERATE_MODEL } from "../_shared/openai.ts";

/** Below this many approved reflections there is not enough to write a growth summary. */
const ENOUGH_FOR_A_SUMMARY = 3;

/**
 * Invoked when a group reaches its final day, or transitions to abandoned or
 * expired_incomplete. Service role only.
 *
 * Writes the full growth summary when there is enough material, and a lighter recap
 * when there is not -- a group that fizzled still gets a closing note rather than an
 * empty screen or an AI straining to find meaning in two sentences.
 */
export async function handleEndOfChallengeSummary(
  req: Request,
  db: SupabaseClient,
  ai: Ai,
  serviceRoleKey: string | string[],
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const body = await readJson<Record<string, unknown>>(req);
  const groupId = requireString(body, "group_id");

  const { data: group } = await db
    .from("groups")
    .select("id, name, challenge_status, plan_challenges(title)")
    .eq("id", groupId)
    .maybeSingle();
  if (!group) throw new HttpError(404, "Group not found");

  // A challenge ends once. Both the cron sweep and a manual "end" can land here.
  const { count: existing } = await db
    .from("ai_insights")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .in("type", ["end_summary", "fallback_recap"]);

  if ((existing ?? 0) > 0) {
    return json({ status: "already_generated" });
  }

  const { data: days } = await db
    .from("day_instances")
    .select("id")
    .eq("group_id", groupId);
  const dayIds = (days ?? []).map((d: { id: string }) => d.id);

  const { data: reflections } = dayIds.length > 0
    ? await db
      .from("reflections")
      .select("content, transcript")
      .in("day_instance_id", dayIds)
      .eq("moderation_status", "approved")
    : { data: [] };

  const texts = (reflections ?? [])
    .map((r: { content: string | null; transcript: string | null }) => r.content ?? r.transcript)
    .filter((t: string | null): t is string => Boolean(t && t.trim()));

  const planTitle = (group.plan_challenges as { title?: string } | null)?.title ?? "the plan";
  const isFull = texts.length >= ENOUGH_FOR_A_SUMMARY;

  const content = isFull
    ? await ai.generateText(
      [
        `A small group just finished "${planTitle}". Here is everything they shared.`,
        "Write four sentences on how this group grew: what they wrestled with,",
        "what changed, and what they can carry forward. Address them as 'you'.",
        "Do not name individuals or quote anyone directly.",
        "",
        ...texts.map((t, i) => `Reflection ${i + 1}: ${t}`),
      ].join("\n"),
      GENERATE_MODEL,
    )
    : await ai.generateText(
      [
        `A small group started "${planTitle}" but did not finish, sharing`,
        `${texts.length} reflection(s) in total.`,
        "Write two warm, non-judgmental sentences closing out the challenge.",
        "Do not imply they failed, and do not invent detail about what they wrote.",
      ].join("\n"),
      CLASSIFY_MODEL,
    );

  const { error } = await db.from("ai_insights").insert({
    group_id: groupId,
    scope: "group_challenge",
    type: isFull ? "end_summary" : "fallback_recap",
    content,
  });

  if (error) {
    console.error("end-of-challenge-summary insert failed", error);
    throw new HttpError(500, "Could not save the summary");
  }

  return json({ status: isFull ? "end_summary" : "fallback_recap" });
}
