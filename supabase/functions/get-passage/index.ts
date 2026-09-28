import { createClient } from "@supabase/supabase-js";
import { requireEnv, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleGetPassage, youVersionSource } from "./handler.ts";

// Berean Standard Bible. The app key only reaches open translations -- NIV (143) returns
// 403 -- so this is a deliberate choice, not a placeholder.
const DEFAULT_BIBLE_ID = 3034;
const DEFAULT_TRANSLATION = "BSB";

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    const source = youVersionSource(requireEnv("YOUVERSION_APP_KEY"));

    return await handleGetPassage(req, db, source, {
      bibleId: Number(Deno.env.get("YOUVERSION_BIBLE_ID") ?? DEFAULT_BIBLE_ID),
      translation: Deno.env.get("YOUVERSION_TRANSLATION") ?? DEFAULT_TRANSLATION,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
});
