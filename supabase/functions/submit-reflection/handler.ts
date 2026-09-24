import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";
import type { Ai } from "../_shared/openai.ts";

const POSTABLE_STATUSES = ["open", "threshold_met"];
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * POST /submit-reflection
 * { day_instance_id, media_type, content?, transcript?, language }
 *   -> { reflection_id, moderation_status }
 *
 * Moderation is the gate, and it runs before anything else. The row is inserted as
 * `pending`, which counts toward nothing; only the later flip to `approved` fires
 * check_day_threshold. Flagged content stops here: it stays hidden, never reaches the
 * generation call, and never counts toward the day.
 */
export async function handleSubmitReflection(
  req: Request,
  db: SupabaseClient,
  ai: Ai,
): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  const dayInstanceId = requireString(body, "day_instance_id");
  const language = requireString(body, "language");
  const mediaType = requireString(body, "media_type");
  if (mediaType !== "text" && mediaType !== "voice") {
    throw new HttpError(400, "media_type must be text or voice");
  }

  // Voice arrives already transcribed on-device; either way there must be words.
  const content = typeof body.content === "string" ? body.content.trim() : null;
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : null;
  const text = mediaType === "voice" ? transcript : content;
  if (!text) {
    throw new HttpError(
      400,
      mediaType === "voice" ? "transcript is required" : "content is required",
    );
  }

  const day = await loadPostableDay(db, dayInstanceId, userId);

  const { data: inserted, error: insertError } = await db
    .from("reflections")
    .insert({
      user_id: userId,
      day_instance_id: dayInstanceId,
      media_type: mediaType,
      content,
      transcript,
      language,
    })
    .select("id")
    .single();

  if (insertError) {
    // 23505 = the unique (user_id, day_instance_id) key: one reflection per day.
    if (insertError.code === "23505") {
      throw new HttpError(409, "You have already posted for this day");
    }
    console.error("submit-reflection insert failed", insertError);
    throw new HttpError(500, "Could not save reflection");
  }

  const reflectionId = inserted.id;

  // From here on the row exists but counts toward nothing. If any step fails we must
  // remove it again: `unique (user_id, day_instance_id)` means a leftover `pending` row
  // would answer every retry with 409, locking the member out of the day permanently
  // over what may have been a momentary upstream blip.
  try {
    const { flagged } = await ai.moderate(text);
    if (flagged) {
      // A deliberate terminal state, not a failure: keep the row so the same content
      // cannot simply be resubmitted, and leave it hidden and uncounted.
      await db
        .from("reflections")
        .update({ moderation_status: "flagged" })
        .eq("id", reflectionId);
      return json({ reflection_id: reflectionId, moderation_status: "flagged" });
    }

    const enrichment = await enrich(db, ai, day.group_id, text, language);

    // One UPDATE carries the enrichment and the approval together, so the trigger sees a
    // complete row the moment the day is allowed to count it.
    const { error: approveError } = await db
      .from("reflections")
      .update({
        ...enrichment,
        is_late: Date.now() > day.windowEndsAt,
        moderation_status: "approved",
      })
      .eq("id", reflectionId);

    if (approveError) {
      console.error("submit-reflection approval failed", approveError);
      throw new HttpError(500, "Could not save reflection");
    }

    return json({ reflection_id: reflectionId, moderation_status: "approved" });
  } catch (err) {
    await db.from("reflections").delete().eq("id", reflectionId);
    throw err;
  }
}

interface PostableDay {
  group_id: string;
  windowEndsAt: number;
}

/**
 * The day must exist, be postable, and belong to a group the caller is in. A late
 * joiner's own 24h window starts when they joined, not when the day opened.
 */
async function loadPostableDay(
  db: SupabaseClient,
  dayInstanceId: string,
  userId: string,
): Promise<PostableDay> {
  const { data: day } = await db
    .from("day_instances")
    .select("id, group_id, opened_at, status")
    .eq("id", dayInstanceId)
    .maybeSingle();

  if (!day) throw new HttpError(404, "Day not found");

  const { data: membership } = await db
    .from("group_members")
    .select("joined_at")
    .eq("group_id", day.group_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!membership) throw new HttpError(403, "Not a member of this group");

  if (!POSTABLE_STATUSES.includes(day.status)) {
    throw new HttpError(409, "This day is closed");
  }

  const openedAt = new Date(day.opened_at).getTime();
  const joinedAt = new Date(membership.joined_at).getTime();
  return {
    group_id: day.group_id,
    windowEndsAt: Math.max(openedAt, joinedAt) + DAY_WINDOW_MS,
  };
}

/**
 * One tiered call produces the sentiment tag, the translations the group needs, and the
 * personalized response. Translation targets each group-mate's preferred_language, which
 * is why the client must overwrite the 'en' placeholder after login.
 */
async function enrich(
  db: SupabaseClient,
  ai: Ai,
  groupId: string,
  text: string,
  language: string,
): Promise<Record<string, unknown>> {
  const { data: members } = await db
    .from("users")
    .select("preferred_language, group_members!inner(group_id)")
    .eq("group_members.group_id", groupId);

  const targets = [
    ...new Set(
      (members ?? [])
        .map((m: { preferred_language: string }) => m.preferred_language)
        .filter((lang: string) => lang && lang !== language),
    ),
  ];

  try {
    const result = await ai.generateJson(
      [
        "You are supporting a small Bible-reading group.",
        "Return JSON with keys: sentiment_tag (one lowercase word),",
        `translations (an object keyed by these language codes: ${JSON.stringify(targets)}),`,
        "and response (two encouraging sentences addressed to the author).",
        `The reflection is in ${language}:`,
        text,
      ].join("\n"),
    );

    return {
      sentiment_tag: typeof result.sentiment_tag === "string" ? result.sentiment_tag : null,
      translated_text: buildTranslations(result, targets),
      ai_response: typeof result.response === "string" && result.response.trim() !== ""
        ? result.response.trim()
        : null,
    };
  } catch (err) {
    // Enrichment is a nicety; losing it must never block a reflection from counting.
    console.error("submit-reflection enrichment failed, approving without it", err);
    return { sentiment_tag: null, translated_text: null, ai_response: null };
  }
}

/** Only real translations, keyed by language code. The AI response has its own column. */
function buildTranslations(
  result: Record<string, unknown>,
  targets: string[],
): Record<string, unknown> | null {
  const translations = result.translations;
  const payload: Record<string, unknown> = {};

  if (translations && typeof translations === "object") {
    for (const lang of targets) {
      const value = (translations as Record<string, unknown>)[lang];
      if (typeof value === "string") payload[lang] = value;
    }
  }
  return Object.keys(payload).length > 0 ? payload : null;
}
