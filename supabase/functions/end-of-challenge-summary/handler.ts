import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";
import { otherLanguages, translateCard } from "../_shared/insight_card.ts";
import { type Ai, GENERATE_MODEL } from "../_shared/openai.ts";
import { type Recap, writeRecap } from "../_shared/recap.ts";

/** Below this many approved reflections there is not enough to write a growth summary. */
const ENOUGH_FOR_A_SUMMARY = 3;

/**
 * Invoked when a group reaches its final day, or transitions to abandoned or
 * expired_incomplete. Service role only.
 *
 * Writes the full growth summary when there is enough material, and a lighter recap
 * when there is not -- a group that fizzled still gets a closing note rather than an
 * empty screen or an AI straining to find meaning in two sentences.
 *
 * Either way the row carries the recap card the design renders: a headline that
 * finishes "You kept coming back to…", a line per member, and how many of the plan's
 * days the group showed up for. The prose stays in `content`.
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
    .select("id, name, challenge_status, plan_challenges(title, day_count)")
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
    .select("id, day_index, status")
    .eq("group_id", groupId);
  const dayList = (days ?? []) as Array<{ id: string; day_index: number; status: string }>;
  const dayIndex = new Map(dayList.map((d) => [d.id, d.day_index]));

  const { data: reflections } = dayList.length > 0
    ? await db
      .from("reflections")
      .select("user_id, day_instance_id, content, transcript")
      .in("day_instance_id", dayList.map((d) => d.id))
      .eq("moderation_status", "approved")
    : { data: [] };

  const authored = (reflections ?? [])
    .map((
      r: {
        user_id: string;
        day_instance_id: string;
        content: string | null;
        transcript: string | null;
      },
    ) => ({
      user_id: r.user_id,
      day_index: dayIndex.get(r.day_instance_id) ?? 0,
      text: (r.content ?? r.transcript ?? "").trim(),
    }))
    .filter((r: { text: string }) => r.text !== "")
    .sort((a: { day_index: number }, b: { day_index: number }) => a.day_index - b.day_index);

  const plan = group.plan_challenges as { title?: string; day_count?: number } | null;
  const planTitle = plan?.title ?? "the plan";
  // "Showed up" is the group clearing a day, which is what the design counts.
  const daysTotal = plan?.day_count ?? dayList.length;
  const daysShowedUp = dayList
    .filter((d) => d.status === "complete" || d.status === "threshold_met").length;

  const { count: memberCount } = await db
    .from("group_members")
    .select("user_id", { count: "exact", head: true })
    .eq("group_id", groupId);

  // The type tells the client how much there was; the card is written either way, so a
  // thin challenge still gets its headline and member lines, only with a gentler close.
  const isFull = authored.length >= ENOUGH_FOR_A_SUMMARY;
  const recap: Recap = authored.length > 0
    ? await writeRecap(ai, {
      title: planTitle,
      span: "the whole plan",
      reflections: authored,
      memberCount: memberCount ?? null,
      daysShowedUp,
      daysTotal,
      thin: !isFull,
    })
    : {
      headline: null,
      members: [],
      summary: await ai.generateText(
        [
          `A small group started "${planTitle}" but nobody posted a reflection.`,
          "Write two warm, non-judgmental sentences closing out the challenge.",
          "Do not imply they failed, and do not invent detail about them.",
        ].join("\n"),
        GENERATE_MODEL,
      ),
    };

  const card = { headline: recap.headline, summary: recap.summary, members: recap.members };
  const targets = await otherLanguages(db, groupId);
  const translated = targets.length > 0 ? await translateCard(ai, card, targets) : null;

  const { error } = await db.from("ai_insights").insert({
    group_id: groupId,
    scope: "group_challenge",
    type: isFull ? "end_summary" : "fallback_recap",
    // The prose stays where it always was, so anything reading `content` keeps working.
    content: recap.summary,
    payload: {
      headline: recap.headline,
      members: recap.members,
      days_showed_up: daysShowedUp,
      days_total: daysTotal,
      reflection_count: authored.length,
    },
    language: "en",
    translated_text: translated,
  });

  if (error) {
    // The one-closing-summary rule is a unique index, so two ends racing past the check
    // above cannot both land. The loser reports what happened rather than failing.
    if (error.code === "23505") return json({ status: "already_generated" });
    console.error("end-of-challenge-summary insert failed", error);
    throw new HttpError(500, "Could not save the summary");
  }

  return json({ status: isFull ? "end_summary" : "fallback_recap" });
}
