import type { SupabaseClient } from "@supabase/supabase-js";
import type { Apns } from "../_shared/apns.ts";
import { requireServiceRole } from "../_shared/auth.ts";
import { json, readJson, requireString } from "../_shared/http.ts";

/**
 * Delivers one notification to one member. Service role only: called by the functions
 * that decide a message is due (today, daily-cron-nudge), never by a client.
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
  const message = { title: requireString(body, "title"), body: requireString(body, "body") };

  const { data: user, error } = await db
    .from("users")
    .select("push_token")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("send-push could not load the member", error);
    return json({ error: "Could not load the member" }, 500);
  }
  if (!user?.push_token) return json({ delivered: false, reason: "no_token" });

  const outcome = await apns.send(user.push_token, message);
  if (outcome === "unregistered") {
    // Apple says the device is gone; stop addressing it on every tick.
    await db.from("users").update({ push_token: null }).eq("id", userId);
  }
  return json(outcome === "sent" ? { delivered: true } : { delivered: false, reason: outcome });
}
