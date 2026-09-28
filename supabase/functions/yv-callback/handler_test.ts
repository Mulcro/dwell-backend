import { assertEquals, assertStringIncludes } from "@std/assert";
import { handleYvCallback } from "./handler.ts";

const get = (query: string) => new Request(`https://x/yv-callback${query}`);
const location = (query: string) => handleYvCallback(get(query)).headers.get("Location")!;

Deno.test("a state-only first callback is replayed to YouVersion", () => {
  // Their flow is three-legged: the first callback deliberately carries no code, and the
  // state must be replayed before one is issued. Bouncing straight to the app here would
  // hand it a code-less URL and strand the sign-in.
  const to = location("?state=abc123");
  assertStringIncludes(to, "https://api.youversion.com/auth/callback");
  assertStringIncludes(to, "state=abc123");
});

Deno.test("granted permissions survive the replay", () => {
  assertStringIncludes(
    location("?state=abc&granted_permissions=highlights"),
    "granted_permissions=highlights",
  );
});

Deno.test("once the code arrives it goes to the app", () => {
  const to = location("?code=abc123&state=xyz");
  assertStringIncludes(to, "dwell://auth-callback?");
  assertStringIncludes(to, "code=abc123");
  assertStringIncludes(to, "state=xyz");
});

Deno.test("a failure goes to the app rather than being replayed", () => {
  // Replaying a denied attempt would loop; the app needs to hear the refusal.
  const to = location("?error=access_denied&error_description=Nope&state=xyz");
  assertStringIncludes(to, "dwell://auth-callback?");
  assertStringIncludes(to, "error=access_denied");
});

Deno.test("drops anything the OAuth response is not allowed to carry", () => {
  const to = location("?code=abc&redirect_uri=https://evil.example&x=1");
  assertStringIncludes(to, "code=abc");
  assertEquals(to.includes("evil.example"), false);
  assertEquals(to.includes("x=1"), false);
});

Deno.test("cannot be turned into an open redirect", () => {
  const to = location("?code=abc&destination=https://evil.example");
  assertEquals(to.startsWith("dwell://auth-callback"), true);
});

Deno.test("a bare request still lands somewhere sensible", () => {
  assertEquals(location(""), "dwell://auth-callback");
});
