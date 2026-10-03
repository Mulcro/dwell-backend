import { createClient } from "@supabase/supabase-js";
import { createApns } from "../_shared/apns.ts";
import { requireEnv, serviceRoleKeys, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleSendPush } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const apns = createApns({
      authKeyBase64: requireEnv("APNS_AUTH_KEY_P8"),
      keyId: requireEnv("APNS_KEY_ID"),
      teamId: requireEnv("APNS_TEAM_ID"),
      bundleId: requireEnv("APNS_BUNDLE_ID"),
      host: requireEnv("APNS_HOST"),
    });
    return await handleSendPush(req, db, apns, serviceRoleKeys());
  } catch (err) {
    return toErrorResponse(err);
  }
});
