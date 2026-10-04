import { assertEquals } from "@std/assert";
import type { Ai } from "./openai.ts";
import { writeRecap } from "./recap.ts";

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const input = {
  title: "Better Together",
  span: "the whole plan",
  reflections: [
    { user_id: ALICE, day_index: 1, text: "I need rest." },
    { user_id: BOB, day_index: 1, text: "Tried a voice note." },
    { user_id: ALICE, day_index: 3, text: "Rest again, on purpose this time." },
  ],
  memberCount: 3,
  daysShowedUp: 6,
  daysTotal: 7,
};

function ai(json: () => Promise<Record<string, unknown>>): Ai & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    moderate: () => Promise.resolve({ flagged: false }),
    moderateImage: () => Promise.resolve({ flagged: false }),
    generateText: () => Promise.resolve("four sentences of prose"),
    generateJson: (prompt: string) => {
      prompts.push(prompt);
      return json();
    },
  };
}

Deno.test("members are numbered per person in first-posted order, with every day beneath them", async () => {
  const model = ai(() =>
    Promise.resolve({
      headline: "rest, and the courage to ask for it",
      summary: "You wrestled. You changed. Carry it.",
      members: [
        { member: 1, line: "Kept coming back to rest" },
        { member: 2, line: "Shared a voice note for the first time" },
        { member: 3, line: "Nobody" },
      ],
    })
  );

  const recap = await writeRecap(model, input);

  assertEquals(recap.headline, "rest, and the courage to ask for it");
  assertEquals(recap.summary, "You wrestled. You changed. Carry it.");
  // Alice is member 1 with two days under her, Bob member 2; there is no member 3.
  assertEquals(recap.members, [
    { user_id: ALICE, line: "Kept coming back to rest" },
    { user_id: BOB, line: "Shared a voice note for the first time" },
  ]);
  const prompt = model.prompts[0];
  assertEquals(
    prompt.includes("Member 1 (posted on 2 of 7 days):\n  Day 1: I need rest.\n  Day 3:"),
    true,
  );
  assertEquals(prompt.includes("Member 2 (posted on 1 of 7 days):"), true);
  assertEquals(prompt.includes("showed up on 6 of 7 days and has 3 members"), true);
});

Deno.test("when the card cannot be produced the recap degrades to prose", async () => {
  const model = ai(() => Promise.reject(new Error("unparseable")));
  const recap = await writeRecap(model, input);
  assertEquals(recap, { headline: null, summary: "four sentences of prose", members: [] });
});
