import { createClient } from "@supabase/supabase-js";
import { supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleDailyCronNudge } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    return await handleDailyCronNudge(req, db, serviceRoleKey);
  } catch (err) {
    return toErrorResponse(err);
  }
});
