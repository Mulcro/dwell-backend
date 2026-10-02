import { assertEquals } from "@std/assert";
import { handleSetAvatar } from "./handler.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { fakeAi } from "../_shared/test_helpers.ts";

const USER = "11111111-1111-1111-1111-111111111111";

interface Recorded {
  queued: Array<{ bucket: string; path: string }>;
  updated: Record<string, unknown> | null;
  // deno-lint-ignore no-explicit-any
  client: any;
}

function fakeDb(
  options: { existingAvatar?: string; canSign?: boolean } = {},
): Recorded {
  const state = {
    queued: [] as Array<{ bucket: string; path: string }>,
    updated: null as Record<string, unknown> | null,
  };

  const table = (name: string) => {
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: () => api,
      maybeSingle: () =>
        Promise.resolve({
          data: name === "users" ? { avatar_path: options.existingAvatar ?? null } : null,
        }),
      update: (row: Record<string, unknown>) => {
        state.updated = row;
        return { eq: () => Promise.resolve({ error: null }) };
      },
      upsert: (row: { bucket: string; path: string }) => {
        state.queued.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return api;
  };

  return {
    get queued() {
      return state.queued;
    },
    get updated() {
      return state.updated;
    },
    client: {
      auth: {
        getUser: (token: string) =>
          Promise.resolve({
            data: { user: token === "good" ? { id: USER } : null },
            error: token === "good" ? null : new Error("bad token"),
          }),
      },
      storage: {
        from: () => ({
          createSignedUrl: () =>
            Promise.resolve(
              options.canSign === false ? { data: null, error: new Error("missing") } : {
                data: { signedUrl: "https://signed.test/a.jpg" },
                error: null,
              },
            ),
        }),
      },
      from: table,
    },
  };
}

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

const ok = { media_path: `${USER}/me.jpg`, media_mime: "image/jpeg" };

Deno.test("a picture that passes moderation is attached to the profile", async () => {
  const db = fakeDb();
  const res = await run(() => handleSetAvatar(post(ok), db.client, fakeAi()));

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { avatar_path: `${USER}/me.jpg` });
  assertEquals(db.updated?.avatar_path, `${USER}/me.jpg`);
  assertEquals(db.queued, []);
});

Deno.test("a picture that fails moderation is destroyed, not merely hidden", async () => {
  const db = fakeDb();
  const res = await run(() => handleSetAvatar(post(ok), db.client, fakeAi({ imageFlagged: true })));

  assertEquals(res.status, 422);
  // Never attached ...
  assertEquals(db.updated, null);
  // ... and not left sitting in the bucket either.
  assertEquals(db.queued, [{ bucket: "avatars", path: `${USER}/me.jpg` }]);
});

Deno.test("replacing a picture discards the one it replaced", async () => {
  const db = fakeDb({ existingAvatar: `${USER}/old.jpg` });
  await run(() => handleSetAvatar(post(ok), db.client, fakeAi()));

  assertEquals(db.queued, [{ bucket: "avatars", path: `${USER}/old.jpg` }]);
});

Deno.test("you cannot adopt someone else's upload", async () => {
  // The path prefix is what the storage policy enforces on upload, so it is also what
  // decides ownership here -- otherwise anyone could claim a group-mate's image.
  const db = fakeDb();
  const res = await run(() =>
    handleSetAvatar(
      post({
        media_path: "22222222-2222-2222-2222-222222222222/theirs.jpg",
        media_mime: "image/jpeg",
      }),
      db.client,
      fakeAi(),
    )
  );

  assertEquals(res.status, 403);
  assertEquals(db.updated, null);
});

Deno.test("a non-image is refused before moderation is called", async () => {
  const db = fakeDb();
  const res = await run(() =>
    handleSetAvatar(
      post({ media_path: `${USER}/x.m4a`, media_mime: "audio/m4a" }),
      db.client,
      fakeAi(),
    )
  );

  assertEquals(res.status, 400);
});

Deno.test("an image that cannot be signed is not accepted on trust", async () => {
  // Moderation has to be able to see it. Failing open here would be a way to attach an
  // unchecked picture by making the signing step fail.
  const db = fakeDb({ canSign: false });
  const res = await run(() => handleSetAvatar(post(ok), db.client, fakeAi()));

  assertEquals(res.status, 404);
  assertEquals(db.updated, null);
});

Deno.test("set-avatar requires a session", async () => {
  const db = fakeDb();
  const res = await run(() => handleSetAvatar(post(ok, "bad"), db.client, fakeAi()));
  assertEquals(res.status, 401);
});
