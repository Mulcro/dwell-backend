import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";
import { type KeyResolver, verifyIdToken } from "../_shared/youversion.ts";

/**
 * POST /youversion-signin
 * { id_token, nonce? } -> { email, token_hash }
 *
 * The bridge between YouVersion sign-in and a Supabase session.
 *
 * YouVersion is a PKCE public client with no client secret, which Supabase's own custom
 * OAuth provider cannot complete -- it performs a confidential-client exchange and never
 * sends a code_verifier. So the app runs YouVersion's flow itself and posts the resulting
 * id_token here. We verify it, find or create the matching Supabase user, and hand back a
 * one-time token the client redeems with verifyOtp for an ordinary session.
 *
 * Ordinary matters: the user gets a real auth.users row, so handle_new_auth_user seeds
 * their profile and every RLS policy downstream works unchanged.
 */
export async function handleYouVersionSignIn(
  req: Request,
  db: SupabaseClient,
  clientId: string,
  keys?: KeyResolver,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(req);
  const idToken = requireString(body, "id_token");
  // An empty string means the client did not bind a nonce, not that the token must
  // carry an empty one -- treating it literally rejects every real token.
  const rawNonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
  const nonce = rawNonce === "" ? undefined : rawNonce;

  const identity = await verifyIdToken(idToken, clientId, { keys, nonce });

  // Create on first sign-in. A duplicate means they are already here, which is the
  // normal case on every sign-in after the first.
  const { error: createError } = await db.auth.admin.createUser({
    email: identity.email,
    email_confirm: true,
    user_metadata: {
      name: identity.name ?? "Friend",
      yvp_id: identity.yvpId,
      avatar_url: identity.pictureUrl,
      provider: "youversion",
    },
  });

  if (createError && !isAlreadyRegistered(createError)) {
    console.error("youversion-signin could not create user", createError);
    throw new HttpError(500, "Could not complete sign-in");
  }

  // A magic-link token the client immediately redeems. It is single-use and short-lived,
  // and is only issued to a caller who has already proved this identity above.
  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email: identity.email,
  });

  if (linkError || !link?.properties?.hashed_token) {
    console.error("youversion-signin could not mint a session", linkError);
    throw new HttpError(500, "Could not complete sign-in");
  }

  return json({
    email: identity.email,
    token_hash: link.properties.hashed_token,
    is_new_user: !createError,
  });
}

/** Supabase reports an existing email differently across versions; match on all of them. */
function isAlreadyRegistered(error: { message?: string; code?: string; status?: number }): boolean {
  const message = (error.message ?? "").toLowerCase();
  return error.code === "email_exists" ||
    error.status === 422 ||
    message.includes("already been registered") ||
    message.includes("already registered") ||
    message.includes("already exists");
}
