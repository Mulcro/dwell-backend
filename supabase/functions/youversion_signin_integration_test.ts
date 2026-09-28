/**
 * The YouVersion bridge against the real local stack.
 *
 * Tokens are signed with a local key pair and the resolver is injected, so nothing calls
 * YouVersion. Everything after verification is real: the user is created in auth, the
 * profile trigger fires, and the returned token is redeemed for an actual session.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { generateKeyPair, SignJWT } from "jose";
import { handleYouVersionSignIn } from "./youversion-signin/handler.ts";
import { YV_ISSUERS } from "./_shared/youversion.ts";
import { invoke, post, serviceClient } from "./_shared/test_helpers.ts";

const CLIENT_ID = "test-app-key";
const LOCAL_URL = "http://127.0.0.1:54321";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const { publicKey, privateKey } = await generateKeyPair("RS256");

function idToken(email: string, extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, name: "Reader", yvp_id: "yvp-abc", ...extra })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(YV_ISSUERS[0])
    .setAudience(CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

Deno.test("youversion sign-in bridge", async (t) => {
  const db = serviceClient();
  const email = `yv-${crypto.randomUUID()}@example.test`;
  let userId = "";

  const signIn = (body: unknown) =>
    invoke(() => handleYouVersionSignIn(post(body), db, CLIENT_ID, publicKey));

  try {
    await t.step("a forged token never reaches the database", async () => {
      const attacker = await generateKeyPair("RS256");
      const now = Math.floor(Date.now() / 1000);
      const forged = await new SignJWT({ email, yvp_id: "yvp-evil" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(YV_ISSUERS[0])
        .setAudience(CLIENT_ID)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(attacker.privateKey);

      const res = await signIn({ id_token: forged });
      assertEquals(res.status, 401);

      const { data } = await db.auth.admin.listUsers();
      assertEquals(data.users.some((u) => u.email === email), false);
    });

    await t.step("first sign-in creates the user and returns a redeemable token", async () => {
      const res = await signIn({ id_token: await idToken(email) });
      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.email, email);
      assertEquals(body.is_new_user, true);
      assertNotEquals(body.token_hash, undefined);

      // THE PROOF: redeem it the way the app will and get a real session.
      const anon = createClient(LOCAL_URL, LOCAL_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await anon.auth.verifyOtp({
        type: "magiclink",
        token_hash: body.token_hash,
      });
      assertEquals(error, null);
      assertEquals(data.session?.user.email, email);
      userId = data.session!.user.id;

      // And the ordinary profile trigger fired, so everything downstream works.
      const { data: profile } = await db
        .from("users").select("name").eq("id", userId).single();
      assertEquals(profile!.name, "Reader");
    });

    await t.step("signing in again reuses the same account", async () => {
      const res = await signIn({ id_token: await idToken(email) });
      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.is_new_user, false);

      const anon = createClient(LOCAL_URL, LOCAL_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data } = await anon.auth.verifyOtp({
        type: "magiclink",
        token_hash: body.token_hash,
      });
      // Same user, not a duplicate account for the same person.
      assertEquals(data.session?.user.id, userId);
    });

    await t.step("an empty nonce means unbound, not 'must be empty'", async () => {
      // Sending nonce: "" once rejected a perfectly good token, because an empty string
      // was compared literally against the claim.
      const req = post({ id_token: await idToken(email), nonce: "" });
      const res = await invoke(() => handleYouVersionSignIn(req, db, CLIENT_ID, publicKey));
      assertEquals(res.status, 200);
    });

    await t.step("a token carrying no email is refused before any write", async () => {
      const res = await signIn({ id_token: await idToken("") });
      assertEquals(res.status, 422);
    });
  } finally {
    if (userId) await db.auth.admin.deleteUser(userId);
  }
});
