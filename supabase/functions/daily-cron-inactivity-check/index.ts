import { createClient } from "@supabase/supabase-js";
import { createDispatch } from "../_shared/dispatch.ts";
import { supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleDailyCronInactivityCheck } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    return await handleDailyCronInactivityCheck(
      req,
      db,
      createDispatch(url, serviceRoleKey),
      serviceRoleKey,
    );
  } catch (err) {
    return toErrorResponse(err);
  }
});
