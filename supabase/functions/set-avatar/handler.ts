import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";
import type { Ai } from "../_shared/openai.ts";

const BUCKET = "avatars";
const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic"];
/** Long enough for the moderation call, short enough to be useless if it leaks. */
const MODERATION_URL_SECONDS = 120;

/**
 * POST /set-avatar
 * { media_path, media_mime } -> { avatar_path } | 422 when the picture is refused
 *
 * A profile picture is shown to everyone in your groups, on screens that appear before
 * anything is unlocked, so it is checked before it is attached to the profile. The
 * moderation endpoint is multimodal: the image is looked at, not merely accepted.
 *
 * Neither avatar column is writable by its owner -- that is revoked at the table -- so
 * this endpoint is the only way a chosen picture reaches a profile.
 */
export async function handleSetAvatar(
  req: Request,
  db: SupabaseClient,
  ai: Ai,
): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  const path = requireString(body, "media_path");
  const mime = requireString(body, "media_mime");

  // Ownership is the path prefix, matching what the storage insert policy enforces, so
  // nobody can adopt an image someone else uploaded.
  if (!path.startsWith(`${userId}/`) || path.includes("..")) {
    throw new HttpError(403, "That image does not belong to you");
  }
  if (!IMAGE_MIME.includes(mime)) {
    throw new HttpError(
      400,
      `media_mime must be one of: ${IMAGE_MIME.join(", ")}`,
    );
  }

  // The bucket is private, so moderation sees the image through a short-lived signed URL
  // rather than the bucket being opened up for the duration.
  const { data: signed, error: signError } = await db.storage
    .from(BUCKET)
    .createSignedUrl(path, MODERATION_URL_SECONDS);

  if (signError || !signed?.signedUrl) {
    console.error("set-avatar could not sign the image", signError);
    throw new HttpError(
      404,
      "That image was not found. Upload it before setting it.",
    );
  }

  const { flagged } = await ai.moderateImage(signed.signedUrl);

  if (flagged) {
    // Destroyed, not merely left unattached: an image nobody may see has no reason to
    // stay in the bucket, and the person who uploaded it has no use for it either.
    await discardImage(db, path);
    throw new HttpError(422, "That picture can't be used as a profile photo");
  }

  // Replacing a picture leaves the old one behind, so it goes the same way.
  const { data: existing } = await db
    .from("users")
    .select("avatar_path")
    .eq("id", userId)
    .maybeSingle();

  const { error } = await db
    .from("users")
    .update({ avatar_path: path })
    .eq("id", userId);

  if (error) {
    console.error("set-avatar could not update the profile", error);
    throw new HttpError(500, "Could not set your picture");
  }

  if (existing?.avatar_path && existing.avatar_path !== path) {
    await discardImage(db, existing.avatar_path);
  }

  return json({ avatar_path: path });
}

/**
 * Queues an image for deletion.
 *
 * Queued rather than deleted inline, like every other discard: cleanup-media retries
 * until Storage confirms, so a Storage hiccup cannot leave a refused picture behind.
 */
async function discardImage(db: SupabaseClient, path: string): Promise<void> {
  const { error } = await db
    .from("media_deletions")
    .upsert({ bucket: BUCKET, path }, { onConflict: "bucket,path" });

  if (error) console.error("could not queue an image for deletion", error);
}
