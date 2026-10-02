import { assertEquals } from "@std/assert";
import { handleGenerateGroupPulse } from "./handler.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { serviceRequest, serviceRoleKey } from "../_shared/test_helpers.ts";
import type { Ai } from "../_shared/openai.ts";

const DAY = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

interface Recorded {
  inserted: Record<string, unknown> | null;
  // deno-lint-ignore no-explicit-any
  client: any;
}

function fakeDb(
  opts: {
    reflections?: Array<{ user_id: string; content: string }>;
    languages?: string[];
    existing?: { id: string; payload: { reflection_count: number } } | null;
  } = {},
): Recorded {
  const state = { inserted: null as Record<string, unknown> | null };
  const rows = opts.reflections ?? [
    { user_id: ALICE, content: "I keep interrupting people." },
    { user_id: BOB, content: "I want to listen more at home." },
  ];

  const table = (name: string) => {
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: (_cols?: string, o?: { head?: boolean }) => (o?.head ? { eq: () => api } : api),
      eq: () => api,
      maybeSingle: () => {
        if (name === "day_instances") {
          return Promise.resolve({
            data: { id: DAY, group_id: "g1", day_index: 3, passage_ref: "JAS.1.19" },
          });
        }
        if (name === "groups") {
          return Promise.resolve({ data: { plan_challenges: { day_count: 7 } } });
        }
        if (name === "ai_insights") return Promise.resolve({ data: opts.existing ?? null });
        return Promise.resolve({ data: null });
      },
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => {
        if (name === "reflections") return resolve({ data: rows, count: 0 });
        if (name === "users") {
          return resolve({
            data: (opts.languages ?? ["en"]).map((l) => ({ preferred_language: l })),
          });
        }
        if (name === "ai_insights") return resolve({ count: 0, data: [] });
        return resolve({ data: [], count: 0 });
      },
      insert: (row: Record<string, unknown>) => {
        state.inserted = row;
        return Promise.resolve({ error: null });
      },
      update: (row: Record<string, unknown>) => {
        state.inserted = row;
        return { eq: () => Promise.resolve({ error: null }) };
      },
    };
    return api;
  };

  return {
    get inserted() {
      return state.inserted;
    },
    client: { from: table },
  };
}

/** Returns a well-formed card, so the mapping and clamping can be asserted. */
function pulseAi(overrides: Record<string, unknown> = {}): Ai {
  return {
    moderate: () => Promise.resolve({ flagged: false }),
    moderateImage: () => Promise.resolve({ flagged: false }),
    generateText: () => Promise.resolve("fallback prose"),
    generateJson: (prompt: string) => {
      if (prompt.startsWith("Translate")) {
        return Promise.resolve({
          fr: { headline: "Un titre", lede: "Avant le jour 4", summary: "…", members: [] },
        });
      }
      return Promise.resolve({
        headline: "Both of you named someone you'd stopped hearing.",
        lede: "Before Day 4",
        summary: "You each noticed the same thing. You differ on what to do about it.",
        members: [
          { member: 1, line: "Letting someone else start the group chat." },
          { member: 2, line: "Ten quiet minutes before bed, phone down." },
        ],
        ...overrides,
      });
    },
  };
}

const run = async (fn: () => Promise<Response>) => {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
};

Deno.test("the pulse carries a headline, a lede and a line per member", async () => {
  const db = fakeDb();
  const res = await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi(),
      serviceRoleKey(),
    )
  );

  assertEquals(res.status, 200);
  const payload = db.inserted?.payload as Record<string, unknown>;
  assertEquals(payload.headline, "Both of you named someone you'd stopped hearing.");
  assertEquals(payload.lede, "Before Day 4");
  // The summary stays in `content`, so anything already reading it still works.
  assertEquals(typeof db.inserted?.content, "string");
});

Deno.test("member positions are mapped back to real people", async () => {
  // The model is never shown a user id -- asking it to copy a UUID back is a needless
  // way to lose the attribution.
  const db = fakeDb();
  await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi(),
      serviceRoleKey(),
    )
  );

  const payload = db.inserted?.payload as { members: Array<{ user_id: string; line: string }> };
  assertEquals(payload.members.map((m) => m.user_id), [ALICE, BOB]);
});

Deno.test("a position outside the group is dropped, not attributed to someone", async () => {
  const db = fakeDb();
  await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi({ members: [{ member: 9, line: "from nowhere" }, { member: 1, line: "real" }] }),
      serviceRoleKey(),
    )
  );

  const payload = db.inserted?.payload as { members: Array<{ user_id: string }> };
  assertEquals(payload.members.map((m) => m.user_id), [ALICE]);
});

Deno.test("the same person is never shown twice", async () => {
  const db = fakeDb();
  await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi({ members: [{ member: 1, line: "first" }, { member: 1, line: "again" }] }),
      serviceRoleKey(),
    )
  );

  const payload = db.inserted?.payload as { members: Array<{ user_id: string }> };
  assertEquals(payload.members.length, 1);
});

Deno.test("not everyone has to have named something", async () => {
  // The design shows three of five, and the headline says so -- the count is meaningful,
  // not a truncation.
  const db = fakeDb();
  await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi({ members: [{ member: 2, line: "only one of them" }] }),
      serviceRoleKey(),
    )
  );

  const payload = db.inserted?.payload as { members: Array<{ user_id: string }> };
  assertEquals(payload.members.map((m) => m.user_id), [BOB]);
});

Deno.test("an overlong headline is clamped rather than breaking the card", async () => {
  const db = fakeDb();
  await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi({ headline: "x".repeat(400) }),
      serviceRoleKey(),
    )
  );

  const payload = db.inserted?.payload as { headline: string };
  assertEquals(payload.headline.length <= 100, true);
});

Deno.test("the pulse is translated for a group that reads another language", async () => {
  const db = fakeDb({ languages: ["en", "fr"] });
  await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi(),
      serviceRoleKey(),
    )
  );

  const translated = db.inserted?.translated_text as Record<string, unknown>;
  assertEquals(typeof translated.fr, "object");
  assertEquals(db.inserted?.language, "en");
});

Deno.test("no translation call when the group all read English", async () => {
  const db = fakeDb({ languages: ["en", "en"] });
  await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi(),
      serviceRoleKey(),
    )
  );

  assertEquals(db.inserted?.translated_text, null);
});

Deno.test("a malformed card still writes the prose it always had", async () => {
  // The day losing its pulse entirely is worse than losing the structure.
  const broken: Ai = {
    moderate: () => Promise.resolve({ flagged: false }),
    moderateImage: () => Promise.resolve({ flagged: false }),
    generateText: () => Promise.resolve("three sentences of prose"),
    generateJson: () => Promise.reject(new Error("unparseable")),
  };
  const db = fakeDb();
  const res = await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      broken,
      serviceRoleKey(),
    )
  );

  assertEquals(res.status, 200);
  assertEquals(db.inserted?.content, "three sentences of prose");
  assertEquals((db.inserted?.payload as { headline: unknown }).headline, null);
});

Deno.test("a service role key is required", async () => {
  const res = await run(() =>
    handleGenerateGroupPulse(
      new Request("http://x", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-key" },
        body: JSON.stringify({ day_instance_id: DAY }),
      }),
      fakeDb().client,
      pulseAi(),
      serviceRoleKey(),
    )
  );
  assertEquals(res.status, 401);
});

Deno.test("the pulse is rewritten when more people post", async () => {
  // It used to be written once, at the instant the day tipped over -- which with a 50%
  // threshold is typically half the group, and anyone posting later never appeared.
  const db = fakeDb({ existing: { id: "insight-1", payload: { reflection_count: 1 } } });
  const res = await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi(),
      serviceRoleKey(),
    )
  );

  assertEquals(await res.json(), { status: "regenerated" });
  // Two reflections now, so the card records what it was written from.
  assertEquals((db.inserted?.payload as { reflection_count: number }).reflection_count, 2);
});

Deno.test("an unchanged day is left alone", async () => {
  // The trigger now fires on every approval past the threshold, and pg_net retries, so
  // a redundant call must cost one read and nothing else.
  const db = fakeDb({ existing: { id: "insight-1", payload: { reflection_count: 2 } } });
  const res = await run(() =>
    handleGenerateGroupPulse(
      serviceRequest({ day_instance_id: DAY }),
      db.client,
      pulseAi(),
      serviceRoleKey(),
    )
  );

  assertEquals(await res.json(), { status: "already_generated" });
  assertEquals(db.inserted, null, "nothing was written");
});
