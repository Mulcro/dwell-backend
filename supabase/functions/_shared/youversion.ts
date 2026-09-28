/**
 * Verifying a YouVersion id_token.
 *
 * This is a sign-in path, so the signature check is the entire security boundary: a
 * forged or replayed token here would let anyone take over any account. Nothing about
 * the token is trusted until jwtVerify has passed, and the audience is pinned to our own
 * client id so a token minted for a different YouVersion app cannot be presented here.
 */
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { HttpError } from "./http.ts";

export const YV_JWKS_URL = "https://api.youversion.com/.well-known/jwks.json";

/**
 * Their discovery document and their written docs disagree about the issuer -- the doc
 * at /.well-known says ".../auth/token" while the sign-in docs say the bare host. Both
 * are accepted rather than guessing which one their tokens actually carry.
 */
export const YV_ISSUERS = [
  "https://api.youversion.com",
  "https://api.youversion.com/auth/token",
];

export interface YouVersionIdentity {
  yvpId: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
}

/** Resolves the signing key. Swapped in tests so no network call is needed. */
export type KeyResolver = Parameters<typeof jwtVerify>[1];

let cachedJwks: KeyResolver | null = null;

function remoteJwks(): KeyResolver {
  // createRemoteJWKSet caches and refreshes on unknown kid, so one per process is right.
  if (!cachedJwks) cachedJwks = createRemoteJWKSet(new URL(YV_JWKS_URL)) as KeyResolver;
  return cachedJwks;
}

export async function verifyIdToken(
  idToken: string,
  clientId: string,
  options: { keys?: KeyResolver; nonce?: string } = {},
): Promise<YouVersionIdentity> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(idToken, options.keys ?? remoteJwks(), {
      issuer: YV_ISSUERS,
      audience: clientId,
    });
    payload = result.payload;
  } catch (err) {
    // Never echo the reason: it tells an attacker which check they failed.
    console.error("youversion id_token rejected", (err as Error).message);
    throw new HttpError(401, "Could not verify YouVersion sign-in");
  }

  // If the client bound a nonce at /authorize, it must come back unchanged, or a token
  // captured from another session could be replayed here.
  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new HttpError(401, "Could not verify YouVersion sign-in");
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) {
    // Without an email there is no stable account to attach to; the token is valid but
    // unusable, which is a different problem from a forged one.
    throw new HttpError(
      422,
      "YouVersion did not return an email address. Grant the email scope and try again.",
    );
  }

  const yvpId = typeof payload.yvp_id === "string"
    ? payload.yvp_id
    : typeof payload.sub === "string"
    ? payload.sub
    : "";
  if (!yvpId) throw new HttpError(401, "Could not verify YouVersion sign-in");

  return {
    yvpId,
    email,
    name: typeof payload.name === "string" && payload.name.trim() !== ""
      ? payload.name.trim()
      : null,
    pictureUrl: typeof payload.profile_picture === "string" ? payload.profile_picture : null,
  };
}
