import { assertEquals } from "@std/assert";
import { handleSubmitReflection } from "./handler.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { fakeAi } from "../_shared/test_helpers.ts";

const USER = "11111111-1111-1111-1111-111111111111";
const GROUP = "22222222-2222-2222-2222-222222222222";
const DAY = "33333333-3333-3333-3333-333333333333";
const REFLECTION = "44444444-4444-4444-4444-444444444444";

interface Recorded {
  queuedForDeletion: string[];
  lastUpdate: Record<string, unknown> | null;
  // deno-lint-ignore no-explicit-any
  client: any;
}

/**
 * A stub database. The integration suite cannot cover this path: the local Storage
 * service cannot complete an upload, so a real flagged recording never exists to assert
 * on. Everything here is recorded, nothing is written.
 */
function fakeDbWithMedia(): Recorded {
  const state = {
    queuedForDeletion: [] as string[],
    lastUpdate: null as Record<string, unknown> | null,
  };

  const table = (name: string) => {
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: () => api,
      // enrich() awaits the users query directly, so the chain has to be thenable.
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => resolve({ data: [], error: null }),
      maybeSingle: () => {
        if (name === "day_instances") {
          return Promise.resolve({
            data: {
              id: DAY,
              group_id: GROUP,
              opened_at: new Date().toISOString(),
              status: "open",
            },
          });
        }
        if (name === "group_members") {
          return Promise.resolve({
            data: { joined_at: new Date().toISOString() },
          });
        }
        return Promise.resolve({ data: null });
      },
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: REFLECTION }, error: null }),
        }),
      }),
      update: (row: Record<string, unknown>) => {
        state.lastUpdate = row;
        return { eq: () => Promise.resolve({ error: null }) };
      },
      upsert: (row: { path: string }) => {
        if (name === "media_deletions") state.queuedForDeletion.push(row.path);
        return Promise.resolve({ error: null });
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
    return api;
  };

  return {
    get queuedForDeletion() {
      return state.queuedForDeletion;
    },
    get lastUpdate() {
      return state.lastUpdate;
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

const post = (body: unknown, token = "good") =>
  new Request("http://x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

const invoke = async (fn: () => Promise<Response>) => {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
};

const voice = (extra: Record<string, unknown> = {}) => ({
  day_instance_id: DAY,
  media_type: "voice",
  transcript: "a reflection",
  language: "en",
  media_path: `${USER}/a.m4a`,
  media_mime: "audio/m4a",
  media_duration_seconds: 12,
  ...extra,
});

const present = { exists: () => Promise.resolve(true) };

Deno.test("a flagged voice reflection has its recording destroyed", async () => {
  // Storage RLS would keep it unreadable, but content the group must never hear should
  // not survive in the bucket depending on a policy staying correct.
  const db = fakeDbWithMedia();
  const res = await invoke(() =>
    handleSubmitReflection(
      post(voice()),
      db.client,
      fakeAi({ flagged: true }),
      present,
    )
  );

  assertEquals(res.status, 200);
  assertEquals((await res.json()).moderation_status, "flagged");
  assertEquals(db.queuedForDeletion, [`${USER}/a.m4a`]);
  // The row keeps the flag so the same content cannot be resubmitted; only audio goes.
  assertEquals(db.lastUpdate?.moderation_status, "flagged");
  assertEquals(db.lastUpdate?.media_path, null);
  assertEquals(db.lastUpdate?.media_peaks, null);
});

Deno.test("an approved voice reflection keeps its recording", async () => {
  const db = fakeDbWithMedia();
  const res = await invoke(() =>
    handleSubmitReflection(post(voice()), db.client, fakeAi(), present)
  );

  assertEquals((await res.json()).moderation_status, "approved");
  assertEquals(db.queuedForDeletion, []);
});

Deno.test("a flagged text reflection queues nothing", async () => {
  // Nothing to delete, and queuing an empty path would poison the cleanup job.
  const db = fakeDbWithMedia();
  await invoke(() =>
    handleSubmitReflection(
      post({
        day_instance_id: DAY,
        media_type: "text",
        content: "bad",
        language: "en",
      }),
      db.client,
      fakeAi({ flagged: true }),
      present,
    )
  );

  assertEquals(db.queuedForDeletion, []);
});

Deno.test("media_peaks are refused unless they are drawable", async () => {
  // A wrong waveform is a visibly broken post, so it is worth refusing at the door.
  for (
    const peaks of [[], new Array(513).fill(5), [0, 101], [0, -1], [0, 1.5], [
      "x",
    ]]
  ) {
    const res = await invoke(() =>
      handleSubmitReflection(
        post(voice({ media_peaks: peaks })),
        fakeDbWithMedia().client,
        fakeAi(),
        present,
      )
    );
    assertEquals(res.status, 400, `expected 400 for ${JSON.stringify(peaks)}`);
  }
});

Deno.test("a valid waveform is stored with the recording", async () => {
  const db = fakeDbWithMedia();
  const res = await invoke(() =>
    handleSubmitReflection(
      post(voice({ media_peaks: [0, 50, 100] })),
      db.client,
      fakeAi(),
      present,
    )
  );

  assertEquals(res.status, 200);
  assertEquals((await res.json()).moderation_status, "approved");
});
