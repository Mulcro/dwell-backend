import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, readJson } from "../_shared/http.ts";

const BUCKET = "reflection-media";
/** Typed by the person, not the app, so a mis-wired call cannot erase an account. */
const CONFIRMATION = "DELETE";

/**
 * POST /delete-account
 * { confirm: "DELETE" } -> { deleted: true }
 *
 * Erases the caller's own account. Apple requires an in-app way to do this for any app
 * that offers account creation (App Store guideline 5.1.1(v)), so this is a submission
 * requirement, not only a courtesy.
 *
 * The caller is always taken from the JWT. There is deliberately no way to name a
 * different user: this endpoint would otherwise be a way to delete someone else.
 *
 * Deleting the auth user cascades through public.users to memberships, reflections,
 * comments, reactions and insights. Two things do NOT follow from that cascade and are
 * handled here:
 *
 *   - Recordings in Storage, which SQL cannot delete. Attached ones are queued by the
 *     trigger on reflections, but anything uploaded and never attached -- a recording
 *     whose submit failed -- is unknown to that trigger. Sweeping the user's folder
 *     catches both, so no audio outlives the account.
 *   - Groups they created, whose created_by is set null. The group survives for its
 *     other members; the group-minimum trigger returns it to `forming` if this drops it
 *     below two.
 */
export async function handleDeleteAccount(
  req: Request,
  db: SupabaseClient,
): Promise<Response> {
  const userId = await requireUser(req, db.auth);
  const body = await readJson<Record<string, unknown>>(req);

  if (body.confirm !== CONFIRMATION) {
    throw new HttpError(
      400,
      `Send confirm: "${CONFIRMATION}" to delete your account`,
    );
  }

  await queueRecordingsForDeletion(db, userId);

  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) {
    console.error("delete-account could not delete the user", error);
    throw new HttpError(500, "Could not delete your account");
  }

  return json({ deleted: true });
}

/**
 * Hands every recording the user owns to the cleanup queue.
 *
 * Queued rather than deleted inline: cleanup-media already retries until Storage
 * confirms, so a Storage hiccup here cannot leave audio behind after the account is
 * gone. The account deletion itself must not be blocked by one -- a person asking to be
 * erased should not be told to come back later.
 */
async function queueRecordingsForDeletion(
  db: SupabaseClient,
  userId: string,
): Promise<void> {
  const { data: files, error } = await db.storage.from(BUCKET).list(userId, {
    limit: 1000,
  });

  if (error) {
    console.error("delete-account could not list recordings", error);
    return;
  }
  if (!files || files.length === 0) return;

  // on_conflict: the reflections trigger may already have queued the attached ones.
  const { error: queueError } = await db
    .from("media_deletions")
    .upsert(
      files.map((f: { name: string }) => ({ path: `${userId}/${f.name}` })),
      { onConflict: "path" },
    );

  if (queueError) {
    console.error("delete-account could not queue recordings", queueError);
  }
}
