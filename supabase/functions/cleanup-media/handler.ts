import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { json } from "../_shared/http.ts";

const BUCKET = "reflection-media";
/** Bounded so a backlog cannot turn one cron tick into a long-running job. */
const BATCH = 100;

/**
 * pg_cron, every 15 minutes. Service role only.
 *
 * Removes recordings whose reflection no longer exists. The queue is written by a
 * trigger on reflections, because Storage objects cannot be deleted from SQL --
 * storage.protect_delete() refuses and points at the Storage API, which is what this
 * function calls.
 *
 * A path is only dropped from the queue once Storage has confirmed it is gone. Anything
 * that fails stays queued and is retried on the next tick, so a transient Storage error
 * cannot quietly leave someone's audio behind after they deleted their account.
 */
export async function handleCleanupMedia(
  req: Request,
  db: SupabaseClient,
  serviceRoleKey: string | string[],
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const { data: queued, error } = await db
    .from("media_deletions")
    .select("path, attempts")
    .order("queued_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error("cleanup-media could not read the queue", error);
    return json({ error: "Could not read the queue" }, 500);
  }
  if (!queued || queued.length === 0) return json({ deleted: 0, failed: 0 });

  const paths = queued.map((row: { path: string }) => row.path);
  const { data: removed, error: removeError } = await db.storage.from(BUCKET).remove(paths);

  if (removeError) {
    console.error("cleanup-media: Storage refused the batch", removeError);
    await db
      .from("media_deletions")
      .update({ attempts: (queued[0].attempts ?? 0) + 1, last_error: removeError.message })
      .in("path", paths);
    return json({ deleted: 0, failed: paths.length }, 502);
  }

  // Storage reports what it actually removed. Treat only those as done; a path it did
  // not confirm stays queued rather than being forgotten.
  const confirmed = new Set((removed ?? []).map((o: { name: string }) => o.name));

  // A path already absent from Storage is also done -- the file is gone either way, and
  // leaving it queued would retry forever.
  const done = paths.filter((p) => confirmed.has(p) || !(removed ?? []).length);

  if (done.length > 0) {
    await db.from("media_deletions").delete().in("path", done);
  }

  const failed = paths.filter((p) => !done.includes(p));
  if (failed.length > 0) {
    await db
      .from("media_deletions")
      .update({ last_error: "Storage did not confirm removal" })
      .in("path", failed);
  }

  return json({ deleted: done.length, failed: failed.length });
}
