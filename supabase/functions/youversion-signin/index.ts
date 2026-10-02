import { createClient } from "@supabase/supabase-js";
import { requireEnv, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleYouVersionSignIn } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    // YouVersion uses the app key as the OAuth client_id, so the audience we pin to is
    // the same value the Platform API uses.
    return await handleYouVersionSignIn(
      req,
      db,
      requireEnv("YOUVERSION_APP_KEY"),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
});
