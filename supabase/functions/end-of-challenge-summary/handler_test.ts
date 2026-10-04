import { assertEquals } from "@std/assert";
import { toErrorResponse } from "../_shared/http.ts";
import type { Ai } from "../_shared/openai.ts";
import { serviceRequest, serviceRoleKey } from "../_shared/test_helpers.ts";
import { handleEndOfChallengeSummary } from "./handler.ts";

const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const DAYS = [
  { id: "d1", day_index: 1, status: "complete" },
  { id: "d2", day_index: 2, status: "complete" },
  { id: "d3", day_index: 3, status: "missed" },
  { id: "d4", day_index: 4, status: "threshold_met" },
];

function fakeDb(
  opts: {
    reflections?: Array<{ user_id: string; day_instance_id: string; content: string }>;
    languages?: string[];
    alreadyWritten?: boolean;
  } = {},
) {
  const state = { inserted: null as Record<string, unknown> | null };
  const rows = opts.reflections ?? [
    { user_id: ALICE, day_instance_id: "d1", content: "I need rest." },
    { user_id: BOB, day_instance_id: "d1", content: "Tried a voice note." },
    { user_id: ALICE, day_instance_id: "d4", content: "Rest, on purpose." },
  ];

  const table = (name: string) => {
    let head = false;
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: (_cols?: string, o?: { head?: boolean }) => {
        head = Boolean(o?.head);
        return api;
      },
      eq: () => api,
      in: () => api,
      maybeSingle: () =>
        Promise.resolve({
          data: name === "groups"
            ? {
              id: GROUP,
              name: "Sunday Crew",
              challenge_status: "completed",
              plan_challenges: { title: "Better Together", day_count: 7 },
            }
            : null,
        }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: any) => {
        if (head && name === "ai_insights") return resolve({ count: opts.alreadyWritten ? 1 : 0 });
        if (head && name === "group_members") return resolve({ count: 3 });
        if (name === "day_instances") return resolve({ data: DAYS });
        if (name === "reflections") return resolve({ data: rows });
        if (name === "users") {
          return resolve({
            data: (opts.languages ?? ["en"]).map((l) => ({ preferred_language: l })),
          });
        }
        return resolve({ data: [], count: 0 });
      },
      insert: (row: Record<string, unknown>) => {
        state.inserted = row;
        return Promise.resolve({ error: null });
      },
    };
    return api;
  };

  return { state, client: { from: table } };
}

function recapAi(): Ai & { jsonCalls: number } {
  const ai = {
    jsonCalls: 0,
    moderate: () => Promise.resolve({ flagged: false }),
    moderateImage: () => Promise.resolve({ flagged: false }),
    generateText: () => Promise.resolve("two warm sentences"),
    generateJson: (prompt: string) => {
      ai.jsonCalls++;
      if (prompt.startsWith("Translate")) {
        return Promise.resolve({
          fr: {
            headline: "le repos",
            summary: "…",
            members: [{ user_id: ALICE, line: "Le repos" }],
          },
        });
      }
      return Promise.resolve({
        headline: "rest, and asking for it",
        summary: "You wrestled. You changed. You can carry it.",
        members: [
          { member: 1, line: "Kept coming back to rest" },
          { member: 2, line: "Shared a voice note for the first time" },
        ],
      });
    },
  };
  return ai;
}

async function run(db: unknown, ai: Ai, req = serviceRequest({ group_id: GROUP })) {
  try {
    // deno-lint-ignore no-explicit-any
    return await handleEndOfChallengeSummary(req, db as any, ai, serviceRoleKey());
  } catch (err) {
    return toErrorResponse(err);
  }
}

Deno.test("a finished challenge gets the recap card: a line per member and the days shown up", async () => {
  const db = fakeDb();
  const res = await run(db.client, recapAi());

  assertEquals(await res.json(), { status: "end_summary" });
  const row = db.state.inserted!;
  assertEquals(row.type, "end_summary");
  assertEquals(row.content, "You wrestled. You changed. You can carry it.");
  assertEquals(row.payload, {
    headline: "rest, and asking for it",
    members: [
      { user_id: ALICE, line: "Kept coming back to rest" },
      { user_id: BOB, line: "Shared a voice note for the first time" },
    ],
    // Three of the four days were cleared; the plan is seven days long.
    days_showed_up: 3,
    days_total: 7,
    reflection_count: 3,
  });
  assertEquals(row.language, "en");
  assertEquals(row.translated_text, null);
});

Deno.test("a French reader gets the card translated, member ids intact", async () => {
  const db = fakeDb({ languages: ["en", "fr"] });
  await run(db.client, recapAi());
  const translated = db.state.inserted!.translated_text as Record<string, { members: unknown[] }>;
  assertEquals(translated.fr.members, [{ user_id: ALICE, line: "Le repos" }]);
});

Deno.test("too little material gets the closing note, with the counts still on it", async () => {
  const db = fakeDb({
    reflections: [{ user_id: ALICE, day_instance_id: "d1", content: "Just me." }],
  });
  const ai = recapAi();
  const res = await run(db.client, ai);

  assertEquals(await res.json(), { status: "fallback_recap" });
  const row = db.state.inserted!;
  assertEquals(row.content, "two warm sentences");
  assertEquals(row.payload, {
    headline: null,
    members: [],
    days_showed_up: 3,
    days_total: 7,
    reflection_count: 1,
  });
  // No card was asked for; the note is prose only.
  assertEquals(ai.jsonCalls, 0);
});

Deno.test("a challenge is summarised once", async () => {
  const db = fakeDb({ alreadyWritten: true });
  const res = await run(db.client, recapAi());
  assertEquals(await res.json(), { status: "already_generated" });
  assertEquals(db.state.inserted, null);
});
