import { assertEquals, assertRejects } from "@std/assert";
import { generateKeyPair, SignJWT } from "jose";
import { HttpError } from "./http.ts";
import { verifyIdToken, YV_ISSUERS } from "./youversion.ts";

const CLIENT_ID = "test-app-key";

const { publicKey, privateKey } = await generateKeyPair("RS256");
// A second, unrelated key: tokens signed with this are forgeries.
const attacker = await generateKeyPair("RS256");

function token(
  claims: Record<string, unknown> = {},
  options: { key?: CryptoKey; expired?: boolean } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: "reader@example.test",
    name: "Reader",
    yvp_id: "yvp-123",
    profile_picture: "https://img.example.test/a.png",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(String(claims.iss ?? YV_ISSUERS[0]))
    .setAudience(String(claims.aud ?? CLIENT_ID))
    .setIssuedAt(options.expired ? now - 7200 : now)
    .setExpirationTime(options.expired ? now - 3600 : now + 3600)
    .sign(options.key ?? privateKey);
}

Deno.test("a valid id_token yields the identity", async () => {
  const identity = await verifyIdToken(await token(), CLIENT_ID, { keys: publicKey });
  assertEquals(identity.yvpId, "yvp-123");
  assertEquals(identity.email, "reader@example.test");
  assertEquals(identity.name, "Reader");
  assertEquals(identity.pictureUrl, "https://img.example.test/a.png");
});

Deno.test("either documented issuer is accepted", async () => {
  // Their discovery doc and their written docs disagree; both must work.
  for (const iss of YV_ISSUERS) {
    const identity = await verifyIdToken(await token({ iss }), CLIENT_ID, { keys: publicKey });
    assertEquals(identity.email, "reader@example.test");
  }
});

Deno.test("a token signed by anyone else is refused", async () => {
  // The whole security boundary: without this, anyone could mint a token for any email.
  await assertRejects(
    async () =>
      verifyIdToken(await token({}, { key: attacker.privateKey }), CLIENT_ID, {
        keys: publicKey,
      }),
    HttpError,
    "Could not verify",
  );
});

Deno.test("a token minted for a different app is refused", async () => {
  const wrongAudience = await token({ aud: "someone-elses-app" });
  await assertRejects(
    () => verifyIdToken(wrongAudience, CLIENT_ID, { keys: publicKey }),
    HttpError,
  );
});

Deno.test("a token from an unexpected issuer is refused", async () => {
  await assertRejects(
    async () =>
      verifyIdToken(await token({ iss: "https://evil.example" }), CLIENT_ID, {
        keys: publicKey,
      }),
    HttpError,
  );
});

Deno.test("an expired token is refused", async () => {
  const stale = await token({}, { expired: true });
  await assertRejects(
    () => verifyIdToken(stale, CLIENT_ID, { keys: publicKey }),
    HttpError,
  );
});

Deno.test("a mismatched nonce is refused, a matching one passes", async () => {
  // Guards replay of a token captured from another sign-in attempt.
  const bound = await token({ nonce: "issued-nonce" });
  await assertRejects(
    () => verifyIdToken(bound, CLIENT_ID, { keys: publicKey, nonce: "different" }),
    HttpError,
  );

  const ok = await verifyIdToken(await token({ nonce: "issued-nonce" }), CLIENT_ID, {
    keys: publicKey,
    nonce: "issued-nonce",
  });
  assertEquals(ok.email, "reader@example.test");
});

Deno.test("a token with no email is a 422, not a 401", async () => {
  // Genuinely signed but unusable: there is no stable account to attach it to. Worth
  // distinguishing so the client can tell the user to grant the email scope.
  const noEmail = await token({ email: "" });
  const err = await verifyIdToken(noEmail, CLIENT_ID, { keys: publicKey })
    .then(() => null)
    .catch((e: HttpError) => e);
  assertEquals(err?.status, 422);
});

Deno.test("email is normalised", async () => {
  const identity = await verifyIdToken(
    await token({ email: "  Reader@Example.TEST  " }),
    CLIENT_ID,
    { keys: publicKey },
  );
  assertEquals(identity.email, "reader@example.test");
});
