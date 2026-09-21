import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { bearerToken, requireServiceRole, requireUser, secretsMatch } from "./auth.ts";
import { HttpError } from "./http.ts";

const withAuth = (value: string) => new Request("http://x", { headers: { Authorization: value } });

Deno.test("bearerToken reads the token, case-insensitively", () => {
  assertEquals(bearerToken(withAuth("Bearer abc123")), "abc123");
  assertEquals(bearerToken(withAuth("bearer abc123")), "abc123");
});

Deno.test("bearerToken returns null when there is nothing to read", () => {
  assertEquals(bearerToken(new Request("http://x")), null);
  assertEquals(bearerToken(withAuth("Basic abc123")), null);
  assertEquals(bearerToken(withAuth("Bearer")), null);
});

Deno.test("secretsMatch compares exactly", () => {
  assertEquals(secretsMatch("secret", "secret"), true);
  assertEquals(secretsMatch("secret", "secrex"), false);
  // A prefix must not pass: length is part of the comparison.
  assertEquals(secretsMatch("secret", "secretlonger"), false);
  assertEquals(secretsMatch("", ""), true);
});

Deno.test("requireServiceRole admits only the service role key", () => {
  requireServiceRole(withAuth("Bearer service-key"), "service-key");

  assertThrows(
    () => requireServiceRole(withAuth("Bearer anon-key"), "service-key"),
    HttpError,
    "Unauthorized",
  );
  assertThrows(
    () => requireServiceRole(new Request("http://x"), "service-key"),
    HttpError,
    "Unauthorized",
  );
});

Deno.test("requireServiceRole refuses when the key is not configured", () => {
  // Otherwise an unset env var would make an empty bearer token authenticate.
  assertThrows(() => requireServiceRole(withAuth("Bearer "), ""), HttpError);
});

Deno.test("requireUser resolves the caller from the token", async () => {
  const auth = {
    getUser: (token: string) =>
      Promise.resolve(
        token === "good"
          ? { data: { user: { id: "user-1" } }, error: null }
          : { data: { user: null }, error: new Error("bad token") },
      ),
  };

  assertEquals(await requireUser(withAuth("Bearer good"), auth), "user-1");

  await assertRejects(
    () => requireUser(withAuth("Bearer bad"), auth),
    HttpError,
    "Unauthorized",
  );
  await assertRejects(() => requireUser(new Request("http://x"), auth), HttpError);
});
