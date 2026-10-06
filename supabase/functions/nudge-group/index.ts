import { createClient } from "@supabase/supabase-js";
import { createInvoke } from "../_shared/dispatch.ts";
import { supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleNudgeGroup, type NudgePush } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const push: NudgePush = { invoke: createInvoke(url, serviceRoleKey) };
    return await handleNudgeGroup(req, db, push);
  } catch (err) {
    return toErrorResponse(err);
  }
});
