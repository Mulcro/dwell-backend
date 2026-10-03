import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, optionalInt, readJson, requireString } from "../_shared/http.ts";
import type { Ai } from "../_shared/openai.ts";

const POSTABLE_STATUSES = ["open", "threshold_met"];
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const MEDIA_BUCKET = "reflection-media";
const MAX_AUDIO_SECONDS = 120;
const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic"];
/** Long enough for the moderation call, short enough to be useless if it leaks. */
const MODERATION_URL_SECONDS = 120;
const AUDIO_MIME = [
  "audio/mp4",
  "audio/m4a",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
];

/**
 * POST /submit-reflection
 * { day_instance_id, media_type, content?, transcript?, language,
 *   media_path?, media_mime?, media_duration_seconds? }
 *   -> { reflection_id, moderation_status, is_late }
 *
 * Moderation is the gate, and it runs before anything else. The row is inserted as
 * `pending`, which counts toward nothing; only the later flip to `approved` fires
 * check_day_threshold. Flagged content stops here: it stays hidden, never reaches the
 * generation call, and never counts toward the day.
 */
/**
 * Whether an uploaded object is really in the bucket.
 *
 * Injected rather than called inline so the validation around it can be tested without a
 * working Storage service -- the local stack's storage-api cannot complete an upload
 * (its own schema is missing the index its UPSERT infers against), while the hosted one
 * is fine.
 */
export interface MediaStore {
  exists(path: string): Promise<boolean>;
  /** A short-lived readable URL, so moderation can see an image the bucket keeps private. */
  signedUrl(path: string): Promise<string | null>;
}

export function supabaseMediaStore(db: SupabaseClient): MediaStore {
  return {
    async exists(path) {
      const slash = path.indexOf("/");
      const { data, error } = await db.storage
        .from(MEDIA_BUCKET)
        .list(path.slice(0, slash), {
          search: path.slice(slash + 1),
          limit: 100,
        });

      if (error) {
        console.error("could not inspect the upload", error);
        throw new HttpError(500, "Could not read the recording");
      }
      return (data ?? []).some((o: { name: string }) => o.name === path.slice(slash + 1));
    },

    async signedUrl(path) {
      const { data, error } = await db.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(path, MODERATION_URL_SECONDS);

      if (error) {
        console.error("could not sign the upload for moderation", error);
        return null;
      }
      return data?.signedUrl ?? null;
    },
  };
}

export async function handleSubmitReflection(
  req: Request,
  db: SupabaseClient,
  ai: Ai,
  media_store?: MediaStore,
): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  const dayInstanceId = requireString(body, "day_instance_id");
  const language = requireString(body, "language");
  const mediaType = requireString(body, "media_type");
  if (mediaType !== "text" && mediaType !== "voice" && mediaType !== "photo") {
    throw new HttpError(400, "media_type must be text, voice or photo");
  }

  // Voice arrives already transcribed on-device. Every kind needs words: a photo posted
  // into a group with nothing said about it is not a reflection, and the caption is also
  // what translation and the group pulse have to work with.
  const content = typeof body.content === "string" ? body.content.trim() : null;
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : null;
  const text = mediaType === "voice" ? transcript : content;
  if (!text) {
    throw new HttpError(
      400,
      mediaType === "voice" ? "transcript is required" : "content is required",
    );
  }

  // A recording is optional even for voice: the transcript is what the day counts and
  // what moderation reads, so a failed upload degrades to text rather than blocking.
  const store = media_store ?? supabaseMediaStore(db);
  const media = await validateMedia(
    store,
    body,
    userId,
    mediaType,
    transcript,
  );

  const mediaKind = media.media_kind as string | undefined;
  delete media.media_kind;

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
      ...media,
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
    const { flagged } = mediaKind === "image"
      ? await moderateImage(ai, store, media.media_path as string, text)
      : await ai.moderate(text as string);
    if (flagged) {
      // A deliberate terminal state, not a failure: keep the row so the same content
      // cannot simply be resubmitted, and leave it hidden and uncounted.
      //
      // The recording itself is destroyed rather than merely hidden. Storage RLS would
      // keep it unreadable, but content the group must never hear should not sit in a
      // bucket depending on a policy staying correct -- and the person who recorded it
      // has no use for it either. The row keeps the flag; only the audio goes.
      await discardRecording(db, media);

      await db
        .from("reflections")
        .update({
          moderation_status: "flagged",
          media_path: null,
          media_mime: null,
          media_duration_seconds: null,
          media_peaks: null,
        })
        .eq("id", reflectionId);
      return json({
        reflection_id: reflectionId,
        moderation_status: "flagged",
        is_late: false,
      });
    }

    const enrichment = await enrich(db, ai, day.group_id, text, language);
    const isLate = Date.now() > day.windowEndsAt;

    // One UPDATE carries the enrichment and the approval together, so the trigger sees a
    // complete row the moment the day is allowed to count it.
    const { error: approveError } = await db
      .from("reflections")
      .update({
        ...enrichment,
        is_late: isLate,
        moderation_status: "approved",
      })
      .eq("id", reflectionId);

    if (approveError) {
      console.error("submit-reflection approval failed", approveError);
      throw new HttpError(500, "Could not save reflection");
    }

    // Returned so the client can show the late badge without re-fetching the row.
    return json({
      reflection_id: reflectionId,
      moderation_status: "approved",
      is_late: isLate,
    });
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
    // The old prompt asked for "translations" without ever saying what to translate,
    // while two candidate texts were in scope: the member's reflection and the response
    // the model was about to write. It usually chose the reflection and sometimes chose
    // its own reply -- which then displayed as the reflection's translation. Naming both
    // explicitly, each with its own key, removes the ambiguity rather than hoping.
    const codes = JSON.stringify(targets);
    const result = await ai.generateJson(
      [
        "You are supporting a small Bible-reading group.",
        "A member's reflection appears at the end of this message.",
        "",
        "Return JSON with exactly these keys:",
        '- "sentiment_tag": one lowercase word for the reflection\'s mood.',
        `- "response": two encouraging sentences addressed to the author, in ${language}.`,
        `- "translations": an object keyed by ${codes}. Each value translates`,
        "  THE MEMBER'S REFLECTION -- their own words below, never your response.",
        `- "response_translations": an object keyed by ${codes}. Each value translates`,
        '  YOUR "response" above, so their group-mates can read it too.',
        "",
        "Translate for meaning rather than word for word. Keep the author's tone,",
        "including frustration: do not soften, sanitise or answer the reflection inside",
        '"translations".',
        "",
        `The reflection, written in ${language}:`,
        text,
      ].join("\n"),
    );

    return {
      sentiment_tag: typeof result.sentiment_tag === "string" ? result.sentiment_tag : null,
      translated_text: pickTranslations(result.translations, targets),
      ai_response: typeof result.response === "string" && result.response.trim() !== ""
        ? result.response.trim()
        : null,
      ai_response_translated: pickTranslations(result.response_translations, targets),
    };
  } catch (err) {
    // Enrichment is a nicety; losing it must never block a reflection from counting.
    console.error(
      "submit-reflection enrichment failed, approving without it",
      err,
    );
    return {
      sentiment_tag: null,
      translated_text: null,
      ai_response: null,
      ai_response_translated: null,
    };
  }
}

/** Only the requested languages, keyed by code. Used for both translation columns. */
function pickTranslations(
  translations: unknown,
  targets: string[],
): Record<string, unknown> | null {
  const payload: Record<string, unknown> = {};

  if (translations && typeof translations === "object") {
    for (const lang of targets) {
      const value = (translations as Record<string, unknown>)[lang];
      // Only the languages we asked for, and only strings: a model that answers with a
      // nested object or an unrequested language should not reach the column.
      if (typeof value === "string" && value.trim() !== "") payload[lang] = value.trim();
    }
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

/**
 * Checks an uploaded recording before it is attached to a reflection.
 *
 * The client uploads straight to Storage before this function runs, so everything about
 * the object is claimed rather than observed until it is checked here. In particular the
 * path is proof of nothing on its own: without the ownership check below, any member
 * could attach a group-mate's upload to their own reflection and pass it off as theirs.
 */
async function validateMedia(
  store: MediaStore,
  body: Record<string, unknown>,
  userId: string,
  mediaType: string,
  transcript: string | null,
): Promise<Record<string, unknown>> {
  if (body.media_path === undefined || body.media_path === null) {
    // A photo is nothing without its image: there is no text to fall back to.
    if (mediaType === "photo") {
      throw new HttpError(400, "media_path is required for a photo reflection");
    }
    return {};
  }

  const path = requireString(body, "media_path");

  if (mediaType === "text") {
    throw new HttpError(400, "A text reflection cannot carry a recording");
  }
  // Moderation, translation and the group pulse all read the transcript. Storing audio
  // without one would put unreadable, unmoderated content in front of the group.
  if (mediaType === "voice" && !transcript) {
    throw new HttpError(400, "transcript is required when sending a recording");
  }

  // Ownership is decided by the path prefix, which is also what the storage policy
  // enforces on upload -- so the two agree on who owns what.
  if (!path.startsWith(`${userId}/`) || path.includes("..")) {
    throw new HttpError(403, "That recording does not belong to you");
  }

  const mime = requireString(body, "media_mime");
  const isImage = mediaType === "photo";
  const allowed = isImage ? IMAGE_MIME : AUDIO_MIME;
  if (!allowed.includes(mime)) {
    throw new HttpError(
      400,
      `media_mime must be one of: ${allowed.join(", ")}`,
    );
  }

  // The object must actually be there. A path pointing at nothing would produce a
  // reflection with a permanently broken play button.
  if (!await store.exists(path)) {
    throw new HttpError(
      404,
      "That upload was not found. Upload it before posting.",
    );
  }

  if (isImage) {
    // A still has no duration and no waveform; accepting either would record something
    // the client would then have to pretend to honour.
    if (
      body.media_duration_seconds !== undefined ||
      body.media_peaks !== undefined
    ) {
      throw new HttpError(400, "A photo has no duration or waveform");
    }
    return { media_path: path, media_mime: mime, media_kind: "image" };
  }

  const duration = optionalInt(
    body,
    "media_duration_seconds",
    1,
    MAX_AUDIO_SECONDS,
  );
  if (duration === undefined) {
    throw new HttpError(
      400,
      "media_duration_seconds is required when sending a recording",
    );
  }

  const peaks = parsePeaks(body.media_peaks);

  return {
    media_path: path,
    media_mime: mime,
    media_duration_seconds: duration,
    media_kind: "audio",
    ...(peaks ? { media_peaks: peaks } : {}),
  };
}

/**
 * Moderates a photo by looking at it.
 *
 * The bucket is private, so the image is handed to moderation as a short-lived signed
 * URL rather than made public for the duration. If it cannot be signed we fail closed:
 * an image nobody has checked must not reach the group.
 */
async function moderateImage(
  ai: Ai,
  store: MediaStore,
  path: string,
  caption: string | null,
): Promise<{ flagged: boolean }> {
  const url = await store.signedUrl(path);
  if (!url) {
    console.error(
      "could not sign an image for moderation; treating it as flagged",
    );
    return { flagged: true };
  }
  return await ai.moderateImage(url, caption);
}

/**
 * Hands a flagged recording to the deletion queue.
 *
 * Queued rather than deleted inline, like account deletion: cleanup-media already
 * retries until Storage confirms, so a Storage hiccup cannot leave flagged audio behind.
 * A failure here must not fail the submission -- the reflection is already flagged and
 * hidden, which is the part that protects the group.
 */
async function discardRecording(
  db: SupabaseClient,
  media: Record<string, unknown>,
): Promise<void> {
  const path = media.media_path;
  if (typeof path !== "string") return;

  const { error } = await db
    .from("media_deletions")
    .upsert({ path }, { onConflict: "path" });

  if (error) {
    console.error("could not queue a flagged recording for deletion", error);
  }
}

/**
 * Waveform amplitudes drawn by the feed's player, computed on-device while recording.
 * Optional: a missing waveform costs a flat bar, a wrong one is a broken-looking post.
 */
function parsePeaks(value: unknown): number[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    throw new HttpError(400, "media_peaks must be 1 to 512 samples");
  }
  for (const peak of value) {
    if (
      typeof peak !== "number" || !Number.isInteger(peak) || peak < 0 ||
      peak > 100
    ) {
      throw new HttpError(
        400,
        "media_peaks must be whole numbers from 0 to 100",
      );
    }
  }
  return value as number[];
}
