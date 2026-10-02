import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, optionalInt, readJson, requireString } from "../_shared/http.ts";
import type { Ai } from "../_shared/openai.ts";

const MEDIA_BUCKET = "reflection-media";
const MAX_AUDIO_SECONDS = 120;
const AUDIO_MIME = [
  "audio/mp4",
  "audio/m4a",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
];
const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic"];
/** Long enough for the moderation call, short enough to be useless if it leaks. */
const MODERATION_URL_SECONDS = 120;

/**
 * POST /submit-comment
 * { reflection_id, media_type, content?, transcript?, media_path?, media_mime?,
 *   media_duration_seconds?, media_peaks? } -> { comment_id }
 *
 * Replaces the direct insert that replies used to use. A reply can now carry audio or an
 * image, which cannot go in unmoderated, so the insert privilege was revoked and this is
 * the only way in.
 *
 * Unlike a reflection, a refused reply is never written at all. A flagged reflection row
 * is kept because `unique (user_id, day_instance_id)` makes it the thing that stops the
 * same content being posted again; comments have no such constraint, so a kept row would
 * prevent nothing and would only leave refused content sitting in the table.
 */
export interface MediaStore {
  exists(path: string): Promise<boolean>;
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
        throw new HttpError(500, "Could not read the upload");
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

/**
 * Whether the caller may reply to this reflection at all.
 *
 * Asked through a client carrying the caller's own token, so the answer comes from the
 * RLS policy already written -- the same single unlock rule reflections, comments and
 * reactions all share. Re-implementing it here would give it a second definition that
 * could drift from the first.
 */
export interface Visibility {
  canSee(reflectionId: string, token: string): Promise<boolean>;
}

export async function handleSubmitComment(
  req: Request,
  db: SupabaseClient,
  ai: Ai,
  visibility: Visibility,
  media_store?: MediaStore,
): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const token = req.headers.get("Authorization")?.slice(7) ?? "";
  const body = await readJson<Record<string, unknown>>(req);

  const reflectionId = requireString(body, "reflection_id");
  const mediaType = body.media_type === undefined ? "text" : requireString(body, "media_type");
  if (!["text", "voice", "photo"].includes(mediaType)) {
    throw new HttpError(400, "media_type must be text, voice or photo");
  }

  if (!await visibility.canSee(reflectionId, token)) {
    // Covers both "no such reflection" and "still sealed" on purpose: which one it is
    // would itself leak whether a group-mate has posted.
    throw new HttpError(403, "You can't reply to this yet");
  }

  const content = typeof body.content === "string" ? body.content.trim() : null;
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : null;

  // Same rules as a reflection, so there is nothing new to learn: a voice reply is
  // carried by its transcript, everything else by its words.
  if (mediaType === "voice") {
    if (!transcript) {
      throw new HttpError(400, "transcript is required for a voice reply");
    }
  } else if (!content) {
    throw new HttpError(400, "content is required");
  }

  const store = media_store ?? supabaseMediaStore(db);
  const media = await validateMedia(store, body, userId, mediaType);

  const clean = await moderate(
    ai,
    store,
    mediaType,
    media.media_path as string | undefined,
    {
      content,
      transcript,
    },
  );

  if (!clean) {
    // Destroyed rather than kept hidden, as everywhere else: content the group must never
    // see has no reason to stay in the bucket.
    if (typeof media.media_path === "string") {
      await discard(db, media.media_path);
    }
    throw new HttpError(422, "That reply can't be posted");
  }

  const { data: inserted, error } = await db
    .from("comments")
    .insert({
      reflection_id: reflectionId,
      user_id: userId,
      content,
      transcript,
      media_type: mediaType,
      ...media,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error("submit-comment insert failed", error);
    if (typeof media.media_path === "string") {
      await discard(db, media.media_path);
    }
    throw new HttpError(500, "Could not post your reply");
  }

  return json({ comment_id: inserted.id }, 201);
}

/** Text is read; an image is looked at, together with whatever was said about it. */
async function moderate(
  ai: Ai,
  store: MediaStore,
  mediaType: string,
  path: string | undefined,
  words: { content: string | null; transcript: string | null },
): Promise<boolean> {
  if (mediaType === "photo" && path) {
    const url = await store.signedUrl(path);
    if (!url) {
      console.error(
        "could not sign a reply image for moderation; treating it as flagged",
      );
      return false;
    }
    const { flagged } = await ai.moderateImage(url, words.content);
    return !flagged;
  }

  const text = mediaType === "voice" ? words.transcript : words.content;
  const { flagged } = await ai.moderate(text as string);
  return !flagged;
}

async function validateMedia(
  store: MediaStore,
  body: Record<string, unknown>,
  userId: string,
  mediaType: string,
): Promise<Record<string, unknown>> {
  if (body.media_path === undefined || body.media_path === null) {
    if (mediaType !== "text") {
      throw new HttpError(
        400,
        `media_path is required for a ${mediaType} reply`,
      );
    }
    return {};
  }

  const path = requireString(body, "media_path");
  if (mediaType === "text") {
    throw new HttpError(400, "A text reply cannot carry media");
  }

  // Ownership is the path prefix, matching what the storage insert policy enforces, so
  // nobody can attach a group-mate's upload to their own reply.
  if (!path.startsWith(`${userId}/`) || path.includes("..")) {
    throw new HttpError(403, "That upload does not belong to you");
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

  if (!await store.exists(path)) {
    throw new HttpError(
      404,
      "That upload was not found. Upload it before replying.",
    );
  }

  if (isImage) {
    if (
      body.media_duration_seconds !== undefined ||
      body.media_peaks !== undefined
    ) {
      throw new HttpError(400, "A photo has no duration or waveform");
    }
    return { media_path: path, media_mime: mime };
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
      "media_duration_seconds is required for a voice reply",
    );
  }

  return {
    media_path: path,
    media_mime: mime,
    media_duration_seconds: duration,
    ...(parsePeaks(body.media_peaks) ? { media_peaks: parsePeaks(body.media_peaks) } : {}),
  };
}

/** Waveform amplitudes, normalized 0-100, drawn by the thread's player. */
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

async function discard(db: SupabaseClient, path: string): Promise<void> {
  const { error } = await db
    .from("media_deletions")
    .upsert({ bucket: MEDIA_BUCKET, path }, { onConflict: "bucket,path" });
  if (error) {
    console.error("could not queue a refused reply upload for deletion", error);
  }
}
