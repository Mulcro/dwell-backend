import { assertEquals } from "@std/assert";
import { toErrorResponse } from "../_shared/http.ts";
import type { Ai } from "../_shared/openai.ts";
import { serviceRequest, serviceRoleKey } from "../_shared/test_helpers.ts";
import { handleWeeklyCronLeaderboard } from "./handler.ts";

const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

// Three days: one from before the week, two that opened in it (one cleared, one not).
const DAYS = [
  { id: "old", day_index: 1, status: "complete", opened_at: ago(10 * 24) },
  { id: "d2", day_index: 2, status: "complete", opened_at: ago(5 * 24) },
  { id: "d3", day_index: 3, status: "open", opened_at: ago(2 * 24) },
];

interface Filter {
  table: string;
  head: boolean;
  op: string;
  column: string;
  value: unknown;
}

function fakeDb(
  opts: {
    reflections?: Array<{ user_id: string; day_instance_id: string; content: string }>;
    alreadyRecapped?: boolean;
    insertError?: { code: string; message: string };
  } = {},
) {
  const state = {
    inserted: null as Record<string, unknown> | null,
    upserted: null as Array<Record<string, unknown>> | null,
    filters: [] as Filter[],
    order: [] as string[],
  };
  const rows = opts.reflections ?? [
    { user_id: ALICE, day_instance_id: "d2", content: "Rest." },
    { user_id: BOB, day_instance_id: "d2", content: "A voice note." },
    // Posted this week, on last week's day: the leaderboard counts it, so must the recap.
    { user_id: ALICE, day_instance_id: "old", content: "Late, but here." },
  ];

  const table = (name: string) => {
    let head = false;
    const filter = (op: string) => (column: string, value: unknown) => {
      state.filters.push({ table: name, head, op, column, value });
      return api;
    };
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: (_cols?: string, o?: { head?: boolean }) => {
        head = Boolean(o?.head);
        return api;
      },
      eq: filter("eq"),
      in: filter("in"),
      gte: filter("gte"),
      maybeSingle: () =>
        Promise.resolve({
          data: name === "groups" ? { plan_challenges: { title: "Better Together" } } : null,
        }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => {
        if (name === "groups") return resolve({ data: [{ id: GROUP }], error: null });
        if (name === "day_instances") return resolve({ data: DAYS });
        if (name === "group_members") {
          return resolve(head ? { count: 2 } : { data: [{ user_id: ALICE }, { user_id: BOB }] });
        }
        if (name === "reflections") return resolve(head ? { count: 1 } : { data: rows });
        if (name === "ai_insights") return resolve({ count: opts.alreadyRecapped ? 1 : 0 });
        if (name === "users") return resolve({ data: [{ preferred_language: "en" }] });
        return resolve({ data: [], count: 0 });
      },
      insert: (row: Record<string, unknown>) => {
        state.order.push("recap");
        if (opts.insertError) return Promise.resolve({ error: opts.insertError });
        state.inserted = row;
        return Promise.resolve({ error: null });
      },
      upsert: (list: Array<Record<string, unknown>>) => {
        state.order.push("leaderboard");
        state.upserted = list;
        return Promise.resolve({ error: null });
      },
    };
    return api;
  };

  return { state, client: { from: table } };
}

function recapAi(opts: { broken?: boolean } = {}): Ai & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    moderate: () => Promise.resolve({ flagged: false }),
    moderateImage: () => Promise.resolve({ flagged: false }),
    generateText: () =>
      opts.broken ? Promise.reject(new Error("down")) : Promise.resolve("a closing note"),
    generateJson: (prompt: string) => {
      prompts.push(prompt);
      return opts.broken ? Promise.reject(new Error("down")) : Promise.resolve({
        headline: "rest",
        summary: "This week you rested.",
        members: [{ member: 1, line: "Kept coming back to rest" }, {
          member: 2,
          line: "Tried voice",
        }],
      });
    },
  };
}

async function run(db: unknown, ai: Ai | null) {
  try {
    // deno-lint-ignore no-explicit-any
    return await handleWeeklyCronLeaderboard(serviceRequest({}), db as any, ai, serviceRoleKey());
  } catch (err) {
    return toErrorResponse(err);
  }
}

Deno.test("the week's recap counts what was posted this week, on whichever day", async () => {
  const db = fakeDb();
  const res = await run(db.client, recapAi());
  const body = await res.json();

  assertEquals(body.recaps, 1);
  assertEquals(body.entries, 2);
  const row = db.state.inserted!;
  assertEquals(row.type, "weekly_recap");
  assertEquals(row.scope, "group_challenge");
  assertEquals(row.content, "This week you rested.");
  const payload = row.payload as Record<string, unknown>;
  assertEquals(payload.headline, "rest");
  assertEquals(payload.members, [
    { user_id: ALICE, line: "Kept coming back to rest" },
    { user_id: BOB, line: "Tried voice" },
  ]);
  // Two days opened this week, one of them cleared.
  assertEquals(payload.days_total, 2);
  assertEquals(payload.days_showed_up, 1);
  // All three posts, including the late one on last week's day.
  assertEquals(payload.reflection_count, 3);
  assertEquals(payload.week_start, body.week_start);

  // The recap's reflections are selected the way the leaderboard's are: every day of the
  // group's, filtered by when the post was made.
  const recapQuery = db.state.filters.filter((f) => f.table === "reflections" && !f.head);
  assertEquals(recapQuery.find((f) => f.op === "in")?.value, ["old", "d2", "d3"]);
  assertEquals(recapQuery.find((f) => f.op === "gte")?.column, "created_at");
});

Deno.test("the leaderboard is written before any recap is attempted", async () => {
  const db = fakeDb();
  await run(db.client, recapAi());
  assertEquals(db.state.order, ["leaderboard", "recap"]);
});

Deno.test("without an AI key the scores still land and recaps are simply skipped", async () => {
  const db = fakeDb();
  const body = await (await run(db.client, null)).json();
  assertEquals(body.entries, 2);
  assertEquals(body.recaps, 0);
  assertEquals(db.state.upserted!.length, 2);
  assertEquals(db.state.inserted, null);
});

Deno.test("a thin week still gets its headline and member lines, closed gently", async () => {
  const db = fakeDb({ reflections: [{ user_id: ALICE, day_instance_id: "d2", content: "Rest." }] });
  const ai = recapAi();
  const body = await (await run(db.client, ai)).json();
  assertEquals(body.recaps, 1);
  const payload = db.state.inserted!.payload as Record<string, unknown>;
  assertEquals(payload.headline, "rest");
  assertEquals(payload.members, [{ user_id: ALICE, line: "Kept coming back to rest" }]);
  assertEquals(ai.prompts[0].includes("two warm, non-judgmental sentences"), true);
});

Deno.test("a week already recapped is left alone", async () => {
  const db = fakeDb({ alreadyRecapped: true });
  const body = await (await run(db.client, recapAi())).json();
  assertEquals(body.recaps, 0);
  assertEquals(db.state.inserted, null);
});

Deno.test("a concurrent run losing the unique-index race is a non-event", async () => {
  const db = fakeDb({ insertError: { code: "23505", message: "duplicate key" } });
  const res = await run(db.client, recapAi());
  assertEquals(res.status, 200);
  assertEquals((await res.json()).recaps, 0);
});

Deno.test("a group with nothing posted this week gets no recap, but keeps its leaderboard", async () => {
  const db = fakeDb({ reflections: [] });
  const body = await (await run(db.client, recapAi())).json();
  assertEquals(body.recaps, 0);
  assertEquals(db.state.inserted, null);
  assertEquals(db.state.upserted!.length, 2);
});

Deno.test("a recap that cannot be written does not cost the leaderboard", async () => {
  const db = fakeDb();
  const res = await run(db.client, recapAi({ broken: true }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).recaps, 0);
  assertEquals(db.state.inserted, null);
  assertEquals(db.state.upserted!.length, 2);
});
