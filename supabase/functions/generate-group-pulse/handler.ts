import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";
import { type Ai, GENERATE_MODEL } from "../_shared/openai.ts";

/**
 * Invoked by the check_day_threshold trigger via pg_net when a day flips to
 * threshold_met. Service role only.
 *
 * Reads the day's APPROVED reflections only -- pending and flagged content must never
 * reach the model -- and writes one group_pulse insight.
 */
export async function handleGenerateGroupPulse(
  req: Request,
  db: SupabaseClient,
  ai: Ai,
  serviceRoleKey: string | string[],
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const body = await readJson<Record<string, unknown>>(req);
  const dayInstanceId = requireString(body, "day_instance_id");

  const { data: day } = await db
    .from("day_instances")
    .select("id, group_id, day_index, passage_ref")
    .eq("id", dayInstanceId)
    .maybeSingle();
  if (!day) throw new HttpError(404, "Day not found");

  // pg_net can retry, and a trigger can fire more than once across a retry; one pulse
  // per day is the rule.
  const { count: existing } = await db
    .from("ai_insights")
    .select("id", { count: "exact", head: true })
    .eq("day_instance_id", dayInstanceId)
    .eq("type", "group_pulse");

  if ((existing ?? 0) > 0) {
    return json({ status: "already_generated" });
  }

  const { data: reflections } = await db
    .from("reflections")
    .select("content, transcript")
    .eq("day_instance_id", dayInstanceId)
    .eq("moderation_status", "approved");

  const texts = (reflections ?? [])
    .map((r: { content: string | null; transcript: string | null }) => r.content ?? r.transcript)
    .filter((t: string | null): t is string => Boolean(t && t.trim()));

  if (texts.length === 0) {
    return json({ status: "nothing_to_summarize" });
  }

  const content = await ai.generateText(
    [
      "These are reflections from one small group on the same Bible passage",
      `(${day.passage_ref}, day ${day.day_index}).`,
      "In three sentences, name the themes they share and where they differ.",
      "Address the group as 'you'. Do not quote anyone directly or name individuals.",
      "",
      ...texts.map((t, i) => `Reflection ${i + 1}: ${t}`),
    ].join("\n"),
    GENERATE_MODEL,
  );

  const { error } = await db.from("ai_insights").insert({
    group_id: day.group_id,
    day_instance_id: dayInstanceId,
    scope: "day_instance",
    type: "group_pulse",
    content,
  });

  if (error) {
    console.error("generate-group-pulse insert failed", error);
    throw new HttpError(500, "Could not save the group pulse");
  }

  return json({ status: "generated" });
}
