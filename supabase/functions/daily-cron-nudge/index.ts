import { createClient } from "@supabase/supabase-js";
import { createDispatch } from "../_shared/dispatch.ts";
import { serviceRoleKeys, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleDailyCronNudge } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const dispatch = createDispatch(url, serviceRoleKey);
    return await handleDailyCronNudge(req, db, dispatch, serviceRoleKeys());
  } catch (err) {
    return toErrorResponse(err);
  }
});
