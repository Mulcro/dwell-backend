/**
 * The recap card: what a group brought over a stretch of days -- the whole plan when a
 * challenge ends, or the week just gone.
 *
 * Same bones as the pulse (a headline, prose, a line per member), but read across days
 * rather than one, so a member's line is what they brought, not what they intend to do.
 * Counts are computed by the caller and handed in; the model is told them and told not
 * to invent others.
 */
import { clip, type Member, readMembers } from "./insight_card.ts";
import { type Ai, GENERATE_MODEL } from "./openai.ts";

export interface RecapInput {
  /** The plan's title. */
  title: string;
  /** "the whole plan" or "this week": what the reflections span. */
  span: string;
  reflections: Array<{ user_id: string; day_index: number; text: string }>;
  memberCount: number | null;
  daysShowedUp: number;
  daysTotal: number;
}

export interface Recap {
  headline: string | null;
  summary: string;
  members: Member[];
}

export async function writeRecap(ai: Ai, input: RecapInput): Promise<Recap> {
  // One numbered entry per person, in the order they first posted, with every day of
  // theirs beneath it -- so the model reads a member, not a scatter of reflections.
  const people: Array<{ user_id: string; days: Array<{ day_index: number; text: string }> }> = [];
  for (const r of input.reflections) {
    let person = people.find((p) => p.user_id === r.user_id);
    if (!person) {
      person = { user_id: r.user_id, days: [] };
      people.push(person);
    }
    person.days.push({ day_index: r.day_index, text: r.text });
  }

  const prompt = [
    `A small group read "${input.title}" together. These are their reflections from`,
    `${input.span}, grouped by member.`,
    "",
    `The group showed up on ${input.daysShowedUp} of ${input.daysTotal} days` +
    (input.memberCount ? ` and has ${input.memberCount} members.` : "."),
    "Any number you state must come from those. Do not invent a count.",
    "",
    "Return JSON with exactly these keys:",
    "",
    '"headline": one line, UNDER 100 characters, that finishes the sentence',
    '  "You kept coming back to…". Name the thread that ran through what they wrote,',
    "  specific to THIS group -- a noticing, not a summary. Start with the thing itself,",
    '  e.g. "listening, both to each other and to what you had been avoiding".',
    "",
    '"summary": four sentences on how this group grew: what they wrestled with, what',
    '  changed, and what they can carry forward. Address them as "you". Do not quote',
    "  anyone or name individuals.",
    "",
    '"members": EXACTLY one entry for each numbered member below, in order:',
    '  { "member": <their number>, "line": <string> }',
    "  line is what this person brought, in your words, under 70 characters, grounded in",
    '  what they wrote -- e.g. "Kept coming back to rest", "Asked the questions that got',
    '  replies". No scores and no judgement.',
    "",
    ...people.map((p, i) =>
      [
        `Member ${i + 1} (posted on ${p.days.length} of ${input.daysTotal} days):`,
        ...p.days.map((d) => `  Day ${d.day_index}: ${d.text}`),
      ].join("\n")
    ),
  ].join("\n");

  try {
    const result = await ai.generateJson(prompt, GENERATE_MODEL);
    return {
      headline: clip(result.headline, 100),
      summary: clip(result.summary, 2000) ?? "",
      members: readMembers(result.members, people),
    };
  } catch (err) {
    // The card degrades to the prose it has always had rather than the group losing its
    // recap entirely.
    console.error("recap generation failed, falling back to prose", err);
    const summary = await ai.generateText(
      [
        `A small group read "${input.title}" together. Here is what they shared ${input.span}.`,
        "Write four sentences on how this group grew: what they wrestled with,",
        "what changed, and what they can carry forward. Address them as 'you'.",
        "Do not name individuals or quote anyone directly.",
        "",
        ...input.reflections.map((r, i) => `Reflection ${i + 1}: ${r.text}`),
      ].join("\n"),
      GENERATE_MODEL,
    );
    return { headline: null, summary, members: [] };
  }
}
