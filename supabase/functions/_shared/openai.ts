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
  /**
   * Moderates an image, and any words sent with it, in one call.
   *
   * omni-moderation-latest is multimodal: it reports sexual, violent and self-harm
   * categories for images, which is the whole reason an image can be accepted at all.
   * The URL is short-lived and signed, so the bucket itself stays private.
   */
  moderateImage(
    imageUrl: string,
    caption?: string | null,
  ): Promise<ModerationResult>;
  generateJson(
    prompt: string,
    model?: string,
  ): Promise<Record<string, unknown>>;
  generateText(prompt: string, model?: string): Promise<string>;
}

/**
 * No call to OpenAI may hang a function. A stalled request fails after this long and
 * surfaces as the same 502 a refused one does, so every caller's fallback path runs.
 */
const AI_TIMEOUT_MS = 60_000;

export interface AiOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function call(
  apiKey: string,
  path: string,
  body: unknown,
  options: AiOptions,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(`https://api.openai.com/v1/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? AI_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`openai ${path} did not answer`, err instanceof Error ? err.name : err);
    throw new HttpError(502, "AI service unavailable");
  }

  if (!res.ok) {
    // Log for us, stay generic for the client: upstream bodies can echo user content.
    console.error(`openai ${path} failed`, res.status);
    throw new HttpError(502, "AI service unavailable");
  }
  return await res.json();
}

export function createAi(apiKey: string, options: AiOptions = {}): Ai {
  return {
    async moderate(input: string): Promise<ModerationResult> {
      const data = await call(apiKey, "moderations", {
        model: "omni-moderation-latest",
        input,
      }, options);
      const results = data.results as Array<{ flagged: boolean }> | undefined;
      // Fail closed: if the shape is unexpected we treat it as flagged rather than
      // letting unmoderated content through the gate.
      if (!results || results.length === 0) return { flagged: true };
      return { flagged: Boolean(results[0].flagged) };
    },

    async moderateImage(
      imageUrl: string,
      caption?: string | null,
    ): Promise<ModerationResult> {
      const input: Array<Record<string, unknown>> = [
        { type: "image_url", image_url: { url: imageUrl } },
      ];
      // A caption is moderated alongside the picture rather than in a second call, so
      // the two are judged together.
      if (caption && caption.trim() !== "") {
        input.push({ type: "text", text: caption });
      }

      const data = await call(apiKey, "moderations", {
        model: "omni-moderation-latest",
        input,
      }, options);
      const results = data.results as Array<{ flagged: boolean }> | undefined;
      // Fail closed, exactly as the text path does: an unreadable answer is treated as
      // flagged rather than letting an unchecked image through.
      if (!results || results.length === 0) return { flagged: true };
      return { flagged: results.some((r) => Boolean(r.flagged)) };
    },

    async generateJson(prompt: string, model = CLASSIFY_MODEL) {
      const data = await call(apiKey, "chat/completions", {
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }, options);
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
      }, options);
      const choices = data.choices as Array<{ message: { content: string } }>;
      return choices[0]?.message?.content ?? "";
    },
  };
}
