import { createClient } from "@supabase/supabase-js";
import { serviceRoleKeys, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleCleanupMedia } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    return await handleCleanupMedia(req, db, serviceRoleKeys());
  } catch (err) {
    return toErrorResponse(err);
  }
});
