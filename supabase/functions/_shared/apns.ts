/**
 * Push delivery: raw APNs over HTTP/2 with a provider token (design doc 5.3).
 *
 * Apple is authenticated with an ES256 JWT signed by the team's .p8 key, which never
 * expires and covers every app on the team. The JWT itself must be under an hour old,
 * so it is cached and reissued rather than signed per message.
 */
import { importPKCS8, SignJWT } from "jose";

export interface ApnsConfig {
  /** The .p8 file's contents, base64-encoded as it is stored in the secret. */
  authKeyBase64: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  /** api.push.apple.com, or api.sandbox.push.apple.com for builds run from Xcode. */
  host: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Groups notifications on the lock screen, e.g. every reply to one reflection. */
  threadId?: string;
  /** Custom keys delivered beside `aps`, so the app knows what to open on tap. */
  data?: Record<string, string>;
}

/** sent: Apple accepted it. unregistered: the device is gone, drop its token. */
export type PushOutcome = "sent" | "unregistered" | "failed";

export interface Apns {
  send(deviceToken: string, message: PushMessage): Promise<PushOutcome>;
}

/** Apple refuses a provider token older than an hour; reissue comfortably before that. */
const TOKEN_TTL_MS = 55 * 60 * 1000;

export function createApns(
  config: ApnsConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Apns {
  let key: CryptoKey | null = null;
  let cached: { jwt: string; issuedAt: number } | null = null;

  async function bearer(): Promise<string> {
    const at = now();
    if (cached && at - cached.issuedAt < TOKEN_TTL_MS) return cached.jwt;
    key ??= await importPKCS8(pem(config.authKeyBase64), "ES256");
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId })
      .setIssuer(config.teamId)
      .setIssuedAt(Math.floor(at / 1000))
      .sign(key);
    cached = { jwt, issuedAt: at };
    return jwt;
  }

  return {
    async send(deviceToken, message) {
      const res = await fetchImpl(`https://${config.host}/3/device/${deviceToken}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${await bearer()}`,
          "apns-topic": config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
        },
        body: JSON.stringify(payload(message)),
      });
      if (res.ok) return "sent";
      // Apple explains a refusal in the body; it is worth a log line and nothing more.
      const reason = await res.text().catch(() => "");
      if (res.status === 410) return "unregistered";
      console.error("apns refused the push", res.status, reason);
      return "failed";
    },
  };
}

/**
 * The APNs body: the alert is title and body only, and the custom keys sit beside `aps`.
 * `aps` is written last so no custom key can replace it.
 */
export function payload(message: PushMessage): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    alert: { title: message.title, body: message.body },
    sound: "default",
  };
  if (message.threadId) aps["thread-id"] = message.threadId;
  return { ...(message.data ?? {}), aps };
}

/** The secret is normally base64 of the .p8 file, but a pasted PEM works too. */
function pem(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.startsWith("-----BEGIN") ? trimmed : atob(trimmed);
}
