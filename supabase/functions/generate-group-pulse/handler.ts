import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";
import {
  clip,
  type Member,
  otherLanguages,
  readMembers,
  translateCard,
} from "../_shared/insight_card.ts";
import { type Ai, GENERATE_MODEL } from "../_shared/openai.ts";

interface Pulse {
  headline: string | null;
  lede: string | null;
  summary: string;
  members: Member[];
}

/**
 * Invoked by the check_day_threshold trigger via pg_net when a day flips to
 * threshold_met. Service role only.
 *
 * Reads the day's APPROVED reflections only -- pending and flagged content must never
 * reach the model -- and writes one group_pulse insight.
 *
 * The card is a headline, a standfirst, a kicker and a line per member who named
 * something they would do. None of that is derivable from the prose block this used to
 * write: a commitment is the companion's reading of what someone meant, not a sentence
 * lifted out of their reflection, so only the model that read it can produce one.
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

  // The card is rewritten as more people post, so this is no longer "write once". What
  // it must not do is rewrite an identical card: pg_net retries, and the trigger now
  // fires on every approval past the threshold.
  const { data: existing } = await db
    .from("ai_insights")
    .select("id, payload")
    .eq("day_instance_id", dayInstanceId)
    .eq("type", "group_pulse")
    .maybeSingle();

  const { data: reflections } = await db
    .from("reflections")
    .select("user_id, content, transcript")
    .eq("day_instance_id", dayInstanceId)
    .eq("moderation_status", "approved");

  // Keep the author alongside the words: a commitment has to be attributable, and the
  // model is never shown a user id -- it answers with a position in this list instead.
  const authored = (reflections ?? [])
    .map((
      r: { user_id: string; content: string | null; transcript: string | null },
    ) => ({
      user_id: r.user_id,
      text: (r.content ?? r.transcript ?? "").trim(),
    }))
    .filter((r: { text: string }) => r.text !== "");

  if (authored.length === 0) {
    return json({ status: "nothing_to_summarize" });
  }

  // Nothing new has been said since the card was written, so leave it alone.
  const writtenFor =
    (existing?.payload as { reflection_count?: number } | null)?.reflection_count ?? 0;
  if (existing && authored.length <= writtenFor) {
    return json({ status: "already_generated" });
  }

  const memberCount = await groupSize(db, day.group_id);
  const totalDays = await planLength(db, day.group_id);
  const pulse = await writePulse(ai, day, authored, totalDays, memberCount);

  const targets = await otherLanguages(db, day.group_id);
  const translated = targets.length > 0
    ? await translateCard(ai, {
      headline: pulse.headline,
      lede: pulse.lede,
      summary: pulse.summary,
      members: pulse.members,
    }, targets)
    : null;

  const row = {
    // Kept as the standfirst, so anything reading `content` today still works.
    content: pulse.summary,
    payload: {
      headline: pulse.headline,
      lede: pulse.lede,
      members: pulse.members,
      // What the card was written from, so a later call knows whether to rewrite it.
      reflection_count: authored.length,
    },
    language: "en",
    translated_text: translated,
  };

  const { error } = existing
    ? await db.from("ai_insights").update(row).eq("id", existing.id)
    : await db.from("ai_insights").insert({
      ...row,
      group_id: day.group_id,
      day_instance_id: dayInstanceId,
      scope: "day_instance",
      type: "group_pulse",
    });

  if (error) {
    console.error("generate-group-pulse write failed", error);
    throw new HttpError(500, "Could not save the group pulse");
  }

  return json({ status: existing ? "regenerated" : "generated" });
}

/** How many people are in the group, so a stated count is true rather than imagined. */
async function groupSize(db: SupabaseClient, groupId: string): Promise<number | null> {
  const { count } = await db
    .from("group_members")
    .select("user_id", { count: "exact", head: true })
    .eq("group_id", groupId);
  return count ?? null;
}

/** How many days the plan runs, so the kicker can say how many are left. */
async function planLength(
  db: SupabaseClient,
  groupId: string,
): Promise<number | null> {
  const { data } = await db
    .from("groups")
    .select("plan_challenges(day_count)")
    .eq("id", groupId)
    .maybeSingle();

  const plan = (data as { plan_challenges?: { day_count?: number } } | null)
    ?.plan_challenges;
  return plan?.day_count ?? null;
}

/**
 * One call produces the whole card.
 *
 * The model is given positions, never user ids: asking a language model to copy a UUID
 * back accurately is a needless way to lose the attribution.
 */
async function writePulse(
  ai: Ai,
  day: { passage_ref: string; day_index: number },
  authored: Array<{ user_id: string; text: string }>,
  totalDays: number | null,
  memberCount: number | null,
): Promise<Pulse> {
  const remaining = totalDays ? totalDays - day.day_index : null;

  const prompt = [
    `These are reflections from one small group on ${day.passage_ref}, day ${day.day_index}`,
    totalDays ? `of ${totalDays}.` : ".",
    "",
    memberCount
      ? `${authored.length} of the ${memberCount} people in this group have posted so far.`
      : `${authored.length} people have posted so far.`,
    "Any number you state must be one of those two. Do not invent a count.",
    "",
    "Return JSON with exactly these keys:",
    "",
    '"headline": one line, UNDER 100 characters, addressed to the group as "you".',
    "  Name something specific about THIS group today -- a noticing, not a summary.",
    '  Where a count is true, say it: "Three of you named someone you had stopped',
    '  hearing" is right; "members showed self-awareness" is not. Never write "one',
    '  member" or "some of you may".',
    "",
    '"lede": a kicker of at most 8 words. ' +
    (remaining && remaining > 0
      ? `Point at what is ahead, e.g. "Before Day ${day.day_index + 1}".`
      : "Point at where they are in the plan."),
    "",
    '"summary": three sentences naming what they share and where they differ.',
    '  Address them as "you". Do not quote anyone or name individuals.',
    "",
    '"members": EXACTLY one entry for each numbered member below, in order:',
    '  { "member": <their number>, "line": <string or null> }',
    "  line is the thing they intend to DO, in your words, under 70 characters.",
    '  Count it even if tentative -- "I want to", "I should", "I keep meaning to".',
    "  Use null only when they named a feeling or a problem and no action at all.",
    "",
    ...authored.map((r, i) => `Member ${i + 1}: ${r.text}`),
  ].join("\n");

  try {
    const result = await ai.generateJson(prompt, GENERATE_MODEL);
    return {
      headline: clip(result.headline, 100),
      lede: clip(result.lede, 60),
      summary: clip(result.summary, 2000) ?? "",
      members: readMembers(result.members, authored),
    };
  } catch (err) {
    // The card degrades to the standfirst it has always had rather than the day losing
    // its pulse entirely.
    console.error("group pulse generation failed, falling back to prose", err);
    const summary = await ai.generateText(
      [
        `These are reflections from one small group on ${day.passage_ref}.`,
        "In three sentences, name the themes they share and where they differ.",
        "Address the group as 'you'. Do not quote anyone directly or name individuals.",
        "",
        ...authored.map((r, i) => `Reflection ${i + 1}: ${r.text}`),
      ].join("\n"),
      GENERATE_MODEL,
    );
    return { headline: null, lede: null, summary, members: [] };
  }
}
