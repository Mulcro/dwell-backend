import { assertEquals, assertStringIncludes } from "@std/assert";
import { handleYvCallback } from "./handler.ts";

const get = (query: string) => new Request(`https://x/yv-callback${query}`);

Deno.test("forwards the authorization code to the app", () => {
  const res = handleYvCallback(get("?code=abc123&state=xyz"));
  assertEquals(res.status, 302);
  const location = res.headers.get("Location")!;
  assertStringIncludes(location, "dwell://auth-callback?");
  assertStringIncludes(location, "code=abc123");
  assertStringIncludes(location, "state=xyz");
});

Deno.test("forwards an error response too", () => {
  // The app needs to know it was denied, not just sit on a spinner.
  const location = handleYvCallback(get("?error=access_denied&error_description=Nope"))
    .headers.get("Location")!;
  assertStringIncludes(location, "error=access_denied");
  assertStringIncludes(location, "error_description=Nope");
});

Deno.test("drops anything the OAuth response is not allowed to carry", () => {
  const location = handleYvCallback(get("?code=abc&redirect_uri=https://evil.example&x=1"))
    .headers.get("Location")!;
  assertStringIncludes(location, "code=abc");
  assertEquals(location.includes("evil.example"), false);
  assertEquals(location.includes("x=1"), false);
});

Deno.test("cannot be turned into an open redirect", () => {
  // The destination is hardcoded; a code must never be forwarded to a caller-chosen URL.
  const location = handleYvCallback(get("?code=abc&destination=https://evil.example"))
    .headers.get("Location")!;
  assertEquals(location.startsWith("dwell://auth-callback"), true);
});

Deno.test("still redirects when there is nothing to forward", () => {
  const res = handleYvCallback(get(""));
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("Location"), "dwell://auth-callback");
});
