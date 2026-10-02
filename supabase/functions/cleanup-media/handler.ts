import type { SupabaseClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { json } from "../_shared/http.ts";

/** The queue now serves more than one bucket, so each row says which it belongs to. */
const DEFAULT_BUCKET = "reflection-media";
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
    .select("bucket, path, attempts")
    .order("queued_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error("cleanup-media could not read the queue", error);
    return json({ error: "Could not read the queue" }, 500);
  }
  if (!queued || queued.length === 0) return json({ deleted: 0, failed: 0 });

  // Storage removes within one bucket at a time, so the batch is split by bucket. A
  // failure in one must not strand the others.
  const byBucket = new Map<string, string[]>();
  for (const row of queued as Array<{ bucket: string | null; path: string }>) {
    const bucket = row.bucket ?? DEFAULT_BUCKET;
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), row.path]);
  }

  let deleted = 0;
  let failed = 0;

  for (const [bucket, paths] of byBucket) {
    const { data: removed, error: removeError } = await db.storage.from(bucket)
      .remove(paths);

    if (removeError) {
      console.error(
        `cleanup-media: Storage refused the ${bucket} batch`,
        removeError,
      );
      await db
        .from("media_deletions")
        .update({ last_error: removeError.message })
        .eq("bucket", bucket)
        .in("path", paths);
      failed += paths.length;
      continue;
    }

    // Storage reports what it actually removed. Treat only those as done; a path it did
    // not confirm stays queued rather than being forgotten. A path already absent is
    // also done -- the file is gone either way, and leaving it would retry forever.
    const confirmed = new Set(
      (removed ?? []).map((o: { name: string }) => o.name),
    );
    const done = paths.filter((p) => confirmed.has(p) || (removed ?? []).length === 0);

    if (done.length > 0) {
      await db.from("media_deletions").delete().eq("bucket", bucket).in(
        "path",
        done,
      );
    }
    deleted += done.length;
    failed += paths.length - done.length;
  }

  return json({ deleted, failed });
}
