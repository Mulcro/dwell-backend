/**
 * What the structured insight cards share.
 *
 * The group pulse, the end-of-challenge recap and the weekly recap are all a headline,
 * some prose and a line per member, authored in English and translated for group-mates
 * who read something else. The model is never shown a user id: it answers with a
 * position in a numbered list, and the mapping back to people happens here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { type Ai, GENERATE_MODEL } from "./openai.ts";

export interface Member {
  user_id: string;
  line: string;
}

/** Maps the model's positions back to real people, dropping anything out of range. */
export function readMembers(
  value: unknown,
  people: Array<{ user_id: string }>,
): Member[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const members: Member[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { member, line } = entry as { member?: unknown; line?: unknown };
    if (typeof member !== "number" || !Number.isInteger(member)) continue;
    if (member < 1 || member > people.length) continue;
    // null is a real answer: that member gave the model nothing to say. Drop it rather
    // than letting it through as an empty line on the card.
    if (typeof line !== "string" || line.trim() === "") continue;

    const userId = people[member - 1].user_id;
    // One line per person: a model that attributes twice should not produce a card that
    // shows the same face twice.
    if (seen.has(userId)) continue;
    seen.add(userId);
    members.push({ user_id: userId, line: line.trim() });
  }
  return members;
}

/** A trimmed string cut to `max`, or null when there is nothing usable. */
export function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? trimmed.slice(0, max).trimEnd() : trimmed;
}

/** Every language the group reads other than the one the card was written in. */
export async function otherLanguages(
  db: SupabaseClient,
  groupId: string,
): Promise<string[]> {
  const { data: members } = await db
    .from("users")
    .select("preferred_language, group_members!inner(group_id)")
    .eq("group_members.group_id", groupId);

  return [
    ...new Set(
      (members ?? [])
        .map((m: { preferred_language: string }) => m.preferred_language)
        .filter((lang: string) => lang && lang !== "en"),
    ),
  ];
}

/**
 * Translates a whole card at once, keyed by target language.
 *
 * Everything the model writes is English, so without this a French-reading member gets
 * an English card in an app whose premise is that a group spanning languages can read
 * each other. Member user_ids survive, so a "Translated from" treatment works line by
 * line. Failure is swallowed: an untranslated card beats no card.
 */
export async function translateCard(
  ai: Ai,
  card: Record<string, unknown>,
  targets: string[],
): Promise<Record<string, unknown> | null> {
  try {
    const result = await ai.generateJson(
      [
        "Translate this group reflection card. Keep it natural, not literal.",
        `Return JSON keyed by these language codes: ${JSON.stringify(targets)}.`,
        `Each value has the same keys as the card: ${JSON.stringify(Object.keys(card))}.`,
        'Inside "members", keep the SAME user_id values in the same order and translate',
        'only "line".',
        "",
        JSON.stringify(card),
      ].join("\n"),
      GENERATE_MODEL,
    );

    const payload: Record<string, unknown> = {};
    for (const lang of targets) {
      const value = (result as Record<string, unknown>)[lang];
      if (value && typeof value === "object") payload[lang] = value;
    }
    return Object.keys(payload).length > 0 ? payload : null;
  } catch (err) {
    console.error("card translation failed, saving untranslated", err);
    return null;
  }
}
