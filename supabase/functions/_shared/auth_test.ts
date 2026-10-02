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
  await assertRejects(
    () => requireUser(new Request("http://x"), auth),
    HttpError,
  );
});

Deno.test("requireServiceRole accepts any of the project's server-side keys", () => {
  // A project can carry the legacy service_role JWT and newer sb_secret_... keys at the
  // same time, and pg_net may present either. Both must be admitted.
  const legacy = "eyJhbGciOiJIUzI1NiJ9.legacy-service-role.sig";
  // Shaped like a real key so the comparison is meaningful, worded so a secret
  // scanner can see at a glance that it is not one.
  const modern = "sb_secret_EXAMPLE_NOT_A_REAL_KEY_000000";
  const keys = [modern, legacy];

  requireServiceRole(withAuth(`Bearer ${legacy}`), keys);
  requireServiceRole(withAuth(`Bearer ${modern}`), keys);

  assertThrows(
    () => requireServiceRole(withAuth("Bearer sb_publishable_EXAMPLE_NOT_A_REAL_KEY"), keys),
    HttpError,
    "Unauthorized",
  );
});

Deno.test("requireServiceRole refuses when no key is configured", () => {
  // An empty list must never degrade into "allow anyone".
  assertThrows(
    () => requireServiceRole(withAuth("Bearer anything"), []),
    HttpError,
  );
  assertThrows(
    () => requireServiceRole(withAuth("Bearer anything"), [""]),
    HttpError,
  );
});
