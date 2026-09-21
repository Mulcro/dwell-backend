/**
 * OpenAI access, tiered per design doc: a cheap model for classification, a mid-tier one
 * for generation. Moderation is a separate, free endpoint and never shares a call with
 * the generation step.
 */
import { HttpError } from "./http.ts";

export const CLASSIFY_MODEL = "gpt-4o-mini";
export const GENERATE_MODEL = "gpt-4o";

export interface ModerationResult {
  flagged: boolean;
}

export interface Ai {
  moderate(input: string): Promise<ModerationResult>;
  generateJson(prompt: string, model?: string): Promise<Record<string, unknown>>;
  generateText(prompt: string, model?: string): Promise<string>;
}

async function call(
  apiKey: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Log for us, stay generic for the client: upstream bodies can echo user content.
    console.error(`openai ${path} failed`, res.status);
    throw new HttpError(502, "AI service unavailable");
  }
  return await res.json();
}

export function createAi(apiKey: string): Ai {
  return {
    async moderate(input: string): Promise<ModerationResult> {
      const data = await call(apiKey, "moderations", {
        model: "omni-moderation-latest",
        input,
      });
      const results = data.results as Array<{ flagged: boolean }> | undefined;
      // Fail closed: if the shape is unexpected we treat it as flagged rather than
      // letting unmoderated content through the gate.
      if (!results || results.length === 0) return { flagged: true };
      return { flagged: Boolean(results[0].flagged) };
    },

    async generateJson(prompt: string, model = CLASSIFY_MODEL) {
      const data = await call(apiKey, "chat/completions", {
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });
      const choices = data.choices as Array<{ message: { content: string } }>;
      try {
        return JSON.parse(choices[0].message.content);
      } catch {
        throw new HttpError(502, "AI service returned an unreadable response");
      }
    },

    async generateText(prompt: string, model = GENERATE_MODEL) {
      const data = await call(apiKey, "chat/completions", {
        model,
        messages: [{ role: "user", content: prompt }],
      });
      const choices = data.choices as Array<{ message: { content: string } }>;
      return choices[0]?.message?.content ?? "";
    },
  };
}
