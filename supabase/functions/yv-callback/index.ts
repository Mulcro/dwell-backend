import { createClient } from "@supabase/supabase-js";
import { supabaseConfig } from "../_shared/env.ts";
import { handleYvCallback } from "./handler.ts";

Deno.serve((req) => {
  let record: ((leg: string, names: string[]) => void) | undefined;

  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    // Fire-and-forget: diagnostics must never delay or break a live sign-in.
    record = (leg, param_names) => {
      db.from("auth_debug").insert({ leg, param_names }).then(({ error }) => {
        if (error) console.error("auth_debug insert failed", error);
      });
    };
  } catch {
    // No database configured is not a reason to fail the redirect.
  }

  return handleYvCallback(req, undefined, undefined, record);
});
