import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError, json, optionalInt, readJson, requireString, toErrorResponse } from "./http.ts";

const post = (body: string) => new Request("http://x", { method: "POST", body });

Deno.test("json sets status and content type", async () => {
  const res = json({ ok: true }, 201);
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  assertEquals(await res.json(), { ok: true });
});

Deno.test("toErrorResponse passes through an HttpError message", async () => {
  const res = toErrorResponse(new HttpError(403, "Not a member"));
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { error: "Not a member" });
});

Deno.test("toErrorResponse hides unexpected failures", async () => {
  // An upstream error can carry user content or provider detail; it must not be echoed.
  const res = toErrorResponse(new Error("openai said: <user reflection text>"));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "Internal error" });
});

Deno.test("readJson rejects non-POST and malformed bodies", async () => {
  assertEquals(await readJson<{ a: number }>(post('{"a":1}')), { a: 1 });

  await assertRejects(
    () => readJson(new Request("http://x")),
    HttpError,
    "Method not allowed",
  );
  await assertRejects(
    () => readJson(post("not json")),
    HttpError,
    "valid JSON",
  );
});

Deno.test("requireString rejects empty, blank and non-string values", () => {
  assertEquals(requireString({ name: "  Crew  " }, "name"), "Crew");

  assertThrows(() => requireString({}, "name"), HttpError, "name is required");
  assertThrows(() => requireString({ name: "   " }, "name"), HttpError);
  assertThrows(() => requireString({ name: 42 }, "name"), HttpError);
});

Deno.test("optionalInt enforces its range but allows absence", () => {
  assertEquals(optionalInt({}, "pct", 1, 100), undefined);
  assertEquals(optionalInt({ pct: 50 }, "pct", 1, 100), 50);

  assertThrows(() => optionalInt({ pct: 0 }, "pct", 1, 100), HttpError);
  assertThrows(() => optionalInt({ pct: 101 }, "pct", 1, 100), HttpError);
  assertThrows(() => optionalInt({ pct: 1.5 }, "pct", 1, 100), HttpError);
  assertThrows(() => optionalInt({ pct: "50" }, "pct", 1, 100), HttpError);
});
