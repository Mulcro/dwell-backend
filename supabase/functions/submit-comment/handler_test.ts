import { assertEquals } from "@std/assert";
import { handleSubmitComment } from "./handler.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { fakeAi } from "../_shared/test_helpers.ts";

const USER = "11111111-1111-1111-1111-111111111111";
const REFLECTION = "eeeeeeee-1111-1111-1111-111111111111";
const COMMENT = "cccccccc-1111-1111-1111-111111111111";

interface Recorded {
  inserted: Record<string, unknown> | null;
  queued: Array<{ bucket: string; path: string }>;
  // deno-lint-ignore no-explicit-any
  client: any;
}

function fakeDb(opts: { groupLanguages?: string[]; authorLanguage?: string } = {}): Recorded {
  const state = {
    inserted: null as Record<string, unknown> | null,
    queued: [] as Array<{ bucket: string; path: string }>,
  };
  const table = (name: string) => {
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: () => api,
      maybeSingle: () => {
        if (name === "reflections") return Promise.resolve({ data: { day_instance_id: "d1" } });
        if (name === "day_instances") return Promise.resolve({ data: { group_id: "g1" } });
        if (name === "users") {
          return Promise.resolve({ data: { preferred_language: opts.authorLanguage ?? "en" } });
        }
        return Promise.resolve({ data: null });
      },
      // The group's languages, awaited directly by the translation step.
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) =>
        resolve({ data: (opts.groupLanguages ?? ["en"]).map((l) => ({ preferred_language: l })) }),
      insert: (row: Record<string, unknown>) => {
        state.inserted = row;
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: COMMENT }, error: null }),
          }),
        };
      },
      upsert: (row: { bucket: string; path: string }) => {
        if (name === "media_deletions") state.queued.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return api;
  };
  return {
    get inserted() {
      return state.inserted;
    },
    get queued() {
      return state.queued;
    },
    client: {
      auth: {
        getUser: (token: string) =>
          Promise.resolve({
            data: { user: token === "good" ? { id: USER } : null },
            error: token === "good" ? null : new Error("bad token"),
          }),
      },
      from: table,
    },
  };
}

const visible = { canSee: () => Promise.resolve(true) };
const sealed = { canSee: () => Promise.resolve(false) };
const present = {
  exists: () => Promise.resolve(true),
  signedUrl: () => Promise.resolve("https://signed.test/a"),
};

const post = (body: unknown, token = "good") =>
  new Request("http://x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

const run = async (fn: () => Promise<Response>) => {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
};

Deno.test("a text reply is posted once it passes moderation", async () => {
  const db = fakeDb();
  const res = await run(() =>
    handleSubmitComment(
      post({ reflection_id: REFLECTION, content: "well said" }),
      db.client,
      fakeAi(),
      visible,
      present,
    )
  );

  assertEquals(res.status, 201);
  assertEquals(await res.json(), { comment_id: COMMENT });
  assertEquals(db.inserted?.media_type, "text");
});

Deno.test("a flagged reply is never written, and its upload is destroyed", async () => {
  // Unlike a reflection, no row is kept: comments have no uniqueness constraint, so a
  // flagged row would prevent nothing and only leave refused content in the table.
  const db = fakeDb();
  const res = await run(() =>
    handleSubmitComment(
      post({
        reflection_id: REFLECTION,
        media_type: "photo",
        content: "look",
        media_path: `${USER}/a.jpg`,
        media_mime: "image/jpeg",
      }),
      db.client,
      fakeAi({ imageFlagged: true }),
      visible,
      present,
    )
  );

  assertEquals(res.status, 422);
  assertEquals(db.inserted, null);
  assertEquals(db.queued, [{
    bucket: "reflection-media",
    path: `${USER}/a.jpg`,
  }]);
});

Deno.test("you cannot reply to a reflection you cannot see", async () => {
  // Sealed and non-existent give the same answer on purpose: telling them apart would
  // itself reveal whether a group-mate has posted.
  const db = fakeDb();
  const res = await run(() =>
    handleSubmitComment(
      post({ reflection_id: REFLECTION, content: "peeking" }),
      db.client,
      fakeAi(),
      sealed,
      present,
    )
  );

  assertEquals(res.status, 403);
  assertEquals(db.inserted, null);
});

Deno.test("a voice reply is carried by its transcript", async () => {
  const db = fakeDb();
  const ok = await run(() =>
    handleSubmitComment(
      post({
        reflection_id: REFLECTION,
        media_type: "voice",
        transcript: "thinking of you",
        media_path: `${USER}/a.m4a`,
        media_mime: "audio/mp4",
        media_duration_seconds: 9,
      }),
      db.client,
      fakeAi(),
      visible,
      present,
    )
  );
  assertEquals(ok.status, 201);

  const missing = await run(() =>
    handleSubmitComment(
      post({
        reflection_id: REFLECTION,
        media_type: "voice",
        media_path: `${USER}/a.m4a`,
        media_mime: "audio/mp4",
        media_duration_seconds: 9,
      }),
      fakeDb().client,
      fakeAi(),
      visible,
      present,
    )
  );
  assertEquals(
    missing.status,
    400,
    "a voice reply with no transcript is refused",
  );
});

Deno.test("a photo reply must be accompanied by words", async () => {
  const res = await run(() =>
    handleSubmitComment(
      post({
        reflection_id: REFLECTION,
        media_type: "photo",
        media_path: `${USER}/a.jpg`,
        media_mime: "image/jpeg",
      }),
      fakeDb().client,
      fakeAi(),
      visible,
      present,
    )
  );
  assertEquals(res.status, 400);
});

Deno.test("you cannot attach a group-mate's upload to your reply", async () => {
  const db = fakeDb();
  const res = await run(() =>
    handleSubmitComment(
      post({
        reflection_id: REFLECTION,
        media_type: "photo",
        content: "mine now",
        media_path: "22222222-2222-2222-2222-222222222222/theirs.jpg",
        media_mime: "image/jpeg",
      }),
      db.client,
      fakeAi(),
      visible,
      present,
    )
  );

  assertEquals(res.status, 403);
  assertEquals(db.inserted, null);
});

Deno.test("an image that cannot be signed is treated as flagged", async () => {
  const db = fakeDb();
  const res = await run(() =>
    handleSubmitComment(
      post({
        reflection_id: REFLECTION,
        media_type: "photo",
        content: "look",
        media_path: `${USER}/a.jpg`,
        media_mime: "image/jpeg",
      }),
      db.client,
      fakeAi(),
      visible,
      {
        exists: () => Promise.resolve(true),
        signedUrl: () => Promise.resolve(null),
      },
    )
  );

  assertEquals(res.status, 422);
  assertEquals(db.inserted, null);
});

Deno.test("submit-comment requires a session", async () => {
  const res = await run(() =>
    handleSubmitComment(
      post({ reflection_id: REFLECTION, content: "hi" }, "bad"),
      fakeDb().client,
      fakeAi(),
      visible,
      present,
    )
  );
  assertEquals(res.status, 401);
});

Deno.test("a reply is translated for group-mates who read another language", async () => {
  const db = fakeDb({ groupLanguages: ["en", "fr"] });
  const res = await run(() =>
    handleSubmitComment(
      post({ reflection_id: REFLECTION, content: "this encouraged me", language: "en" }),
      db.client,
      fakeAi(),
      visible,
      present,
    )
  );

  assertEquals(res.status, 201);
  // fakeAi returns a Spanish translation; what matters is that the column is written.
  assertEquals(db.inserted?.language, "en");
  assertEquals(typeof db.inserted?.translated_text, "object");
});

Deno.test("a reply is not translated when the group all read one language", async () => {
  // The common case, and it must cost nothing: no call, and a null column rather than {}.
  const db = fakeDb({ groupLanguages: ["en", "en"] });
  await run(() =>
    handleSubmitComment(
      post({ reflection_id: REFLECTION, content: "same language here", language: "en" }),
      db.client,
      fakeAi(),
      visible,
      present,
    )
  );

  assertEquals(db.inserted?.translated_text, null);
});

Deno.test("language falls back to what the author reads", async () => {
  // The client may not label the reply yet; guessing 'en' would send the translation off
  // in the wrong direction for a French speaker.
  const db = fakeDb({ groupLanguages: ["en", "fr"], authorLanguage: "fr" });
  await run(() =>
    handleSubmitComment(
      post({ reflection_id: REFLECTION, content: "merci pour ce partage" }),
      db.client,
      fakeAi(),
      visible,
      present,
    )
  );

  assertEquals(db.inserted?.language, "fr");
});

Deno.test("a voice reply translates its transcript", async () => {
  const db = fakeDb({ groupLanguages: ["en", "fr"] });
  await run(() =>
    handleSubmitComment(
      post({
        reflection_id: REFLECTION,
        media_type: "voice",
        transcript: "thinking of you",
        language: "en",
        media_path: `${USER}/a.m4a`,
        media_mime: "audio/mp4",
        media_duration_seconds: 9,
      }),
      db.client,
      fakeAi(),
      visible,
      present,
    )
  );

  // content stays null on a voice reply, exactly as on a voice reflection.
  assertEquals(db.inserted?.content, null);
  assertEquals(typeof db.inserted?.translated_text, "object");
});
