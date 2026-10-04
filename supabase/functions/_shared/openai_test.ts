import { assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "./http.ts";
import { createAi } from "./openai.ts";

/** A fetch that never answers but honours the abort signal, as a stalled upstream would. */
const hangingFetch =
  ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;

Deno.test("a stalled request fails after the timeout as a 502, not a hang", async () => {
  const ai = createAi("sk-test", { timeoutMs: 20, fetchImpl: hangingFetch });
  const started = Date.now();
  const err = await assertRejects(() => ai.generateText("hello"), HttpError);
  assertEquals(err.status, 502);
  assertEquals(err.message, "AI service unavailable");
  assertEquals(Date.now() - started < 2000, true);
});

Deno.test("moderation stalls the same way, so a caller's fail-closed path still runs", async () => {
  const ai = createAi("sk-test", { timeoutMs: 20, fetchImpl: hangingFetch });
  const err = await assertRejects(() => ai.moderate("hello"), HttpError);
  assertEquals(err.status, 502);
});
