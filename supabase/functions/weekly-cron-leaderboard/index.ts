import { createClient } from "@supabase/supabase-js";
import { serviceRoleKeys, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { createAi } from "../_shared/openai.ts";
import { handleWeeklyCronLeaderboard } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    // The leaderboard never needed AI; the recap does, and it is optional. A project
    // without the key still gets its scores.
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    const ai = apiKey ? createAi(apiKey) : null;
    return await handleWeeklyCronLeaderboard(req, db, ai, serviceRoleKeys());
  } catch (err) {
    return toErrorResponse(err);
  }
});
