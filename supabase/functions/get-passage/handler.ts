import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";

/**
 * Fetches passage text from YouVersion, through a cache.
 *
 * Exists as a backend function rather than a direct client call so the app key stays off
 * the device, the same seven passages are not re-fetched by every member every day, and
 * YouVersion's response shape does not leak into the client's models.
 */
export interface PassageSource {
  fetch(bibleId: number, ref: string): Promise<{
    reference: string;
    content: string;
  }>;
}

export async function handleGetPassage(
  req: Request,
  db: SupabaseClient,
  source: PassageSource,
  config: { bibleId: number; translation: string },
): Promise<Response> {
  await requireUser(req, db.auth);

  const body = await readJson<Record<string, unknown>>(req);
  const ref = requireString(body, "ref");

  // USFM ids only: BOOK.CHAPTER[.VERSE[-VERSE]]. Rejecting anything else keeps a client
  // bug from turning into an arbitrary upstream request.
  if (!/^[A-Z0-9]{3}\.\d+(\.\d+(-\d+)?)?$/i.test(ref)) {
    throw new HttpError(400, "ref must be a USFM id, such as PSA.34.18 or ROM.5.3-5");
  }

  const bibleId = config.bibleId;

  const { data: cached } = await db
    .from("passage_cache")
    .select("reference, translation, content, audio_url")
    .eq("bible_id", bibleId)
    .eq("passage_ref", ref)
    .maybeSingle();

  if (cached) {
    return json({ ref, bible_id: bibleId, ...cached, cached: true });
  }

  const passage = await source.fetch(bibleId, ref);

  const row = {
    bible_id: bibleId,
    passage_ref: ref,
    reference: passage.reference,
    translation: config.translation,
    content: passage.content,
    audio_url: null,
  };

  // A failed cache write must not fail the request; the text is already in hand.
  const { error } = await db.from("passage_cache").upsert(row, {
    onConflict: "bible_id,passage_ref",
  });
  if (error) console.error("get-passage could not cache", error);

  return json({
    ref,
    bible_id: bibleId,
    reference: row.reference,
    translation: row.translation,
    content: row.content,
    audio_url: null,
    cached: false,
  });
}

/** The real YouVersion Platform API. */
export function youVersionSource(appKey: string): PassageSource {
  return {
    async fetch(bibleId, ref) {
      const res = await fetch(
        `https://api.youversion.com/v1/bibles/${bibleId}/passages/${ref}?format=text`,
        { headers: { "X-YVP-App-Key": appKey } },
      );

      if (res.status === 404) throw new HttpError(404, "Passage not found");
      if (!res.ok) {
        // 403 here means the bible is not licensed to this app key, which is a
        // configuration problem rather than anything the caller did.
        console.error("youversion passages failed", res.status, `bible=${bibleId} ref=${ref}`);
        throw new HttpError(502, "Bible service unavailable");
      }

      const data = await res.json() as { reference?: string; content?: string };
      if (!data.content) throw new HttpError(502, "Bible service returned no text");

      return { reference: data.reference ?? ref, content: data.content };
    },
  };
}
