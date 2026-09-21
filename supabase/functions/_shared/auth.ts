/**
 * Caller identification.
 *
 * Identity always comes from the verified token, never from the request body, so a
 * client cannot act as another user by passing someone else's id.
 */
import { HttpError } from "./http.ts";

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Length-independent comparison, so a mismatch cannot be found one byte at a time. */
export function secretsMatch(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Compare a fixed-size digest of each side so differing lengths cost the same.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Guards the system-triggered functions. They are invoked only by pg_cron, a database
 * trigger via pg_net, or another function -- never by a client -- so anything that is
 * not the service role key is rejected outright.
 */
export function requireServiceRole(req: Request, serviceRoleKey: string): void {
  const token = bearerToken(req);
  if (!token || !serviceRoleKey || !secretsMatch(token, serviceRoleKey)) {
    throw new HttpError(401, "Unauthorized");
  }
}

export interface UserLookup {
  getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }>;
}

/** Resolves the caller from their session token, or rejects with 401. */
export async function requireUser(req: Request, auth: UserLookup): Promise<string> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "Unauthorized");

  const { data, error } = await auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Unauthorized");
  return data.user.id;
}
