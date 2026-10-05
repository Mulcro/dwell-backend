import type { SupabaseClient } from "@supabase/supabase-js";
import type { Apns } from "../_shared/apns.ts";
import { requireServiceRole } from "../_shared/auth.ts";
import { HttpError, json, readJson, requireString } from "../_shared/http.ts";

/**
 * Delivers one notification to one member. Service role only: called by the functions
 * that decide a message is due (daily-cron-nudge, submit-comment), never by a client.
 *
 * { user_id, title, body, thread_id?, data? } -- `data` is a flat object of strings sent
 * beside `aps` so the app can open the right screen on tap (KAN-22).
 *
 * The member's per-type switches are honoured here, the one place every sender goes
 * through: a push whose `data.type` they have turned off is not sent at all, so it never
 * reaches the lock screen. A missing switch is on.
 *
 * Delivery is best effort. A member with no token, or whose device Apple no longer
 * knows, gets `delivered: false` and nothing else happens -- the ai_insights row that
 * prompted the push is still there for them in the app.
 */
export async function handleSendPush(
  req: Request,
  db: SupabaseClient,
  apns: Apns,
  serviceRoleKey: string | string[],
): Promise<Response> {
  requireServiceRole(req, serviceRoleKey);

  const body = await readJson<Record<string, unknown>>(req);
  const userId = requireString(body, "user_id");
  const data = readData(body.data);
  const message = {
    title: requireString(body, "title"),
    body: requireString(body, "body"),
    ...(body.thread_id === undefined ? {} : { threadId: requireString(body, "thread_id") }),
    ...(data ? { data } : {}),
  };

  const { data: user, error } = await db
    .from("users")
    .select("push_token, notification_prefs")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("send-push could not load the member", error);
    return json({ error: "Could not load the member" }, 500);
  }
  if (!user?.push_token) return json({ delivered: false, reason: "no_token" });

  const type = message.data?.type;
  const prefs = (user.notification_prefs ?? {}) as Record<string, unknown>;
  if (type && prefs[type] === false) return json({ delivered: false, reason: "muted" });

  const outcome = await apns.send(user.push_token, message);
  if (outcome === "unregistered") {
    // Apple says the device is gone. Clear the token only if it is still the one we
    // sent to: a phone that re-registered while this push was in flight keeps its new one.
    const { error: clearError } = await db
      .from("users")
      .update({ push_token: null })
      .eq("id", userId)
      .eq("push_token", user.push_token);
    if (clearError) console.error("send-push could not clear a dead token", clearError);
  }
  return json(outcome === "sent" ? { delivered: true } : { delivered: false, reason: outcome });
}

/** Custom keys must be flat strings, and may not be called `aps`. */
function readData(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "data must be an object of strings");
  }
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "aps" || typeof v !== "string") {
      throw new HttpError(400, "data must be an object of strings, without an aps key");
    }
    out[key] = v;
  }
  return out;
}
