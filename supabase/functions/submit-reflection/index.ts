import { createClient } from "@supabase/supabase-js";
import { requireEnv, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { createAi } from "../_shared/openai.ts";
import { handleSubmitReflection } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const ai = createAi(requireEnv("OPENAI_API_KEY"));
    return await handleSubmitReflection(req, db, ai);
  } catch (err) {
    return toErrorResponse(err);
  }
});
