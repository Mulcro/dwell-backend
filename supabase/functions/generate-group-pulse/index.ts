import { createClient } from "@supabase/supabase-js";
import { requireEnv, serviceRoleKeys, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { createAi } from "../_shared/openai.ts";
import { handleGenerateGroupPulse } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    const ai = createAi(requireEnv("OPENAI_API_KEY"));
    return await handleGenerateGroupPulse(req, db, ai, serviceRoleKeys());
  } catch (err) {
    return toErrorResponse(err);
  }
});
