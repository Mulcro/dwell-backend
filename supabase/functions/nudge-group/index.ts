import { createClient } from "@supabase/supabase-js";
import { createDispatch } from "../_shared/dispatch.ts";
import { supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { handleNudgeGroup, type NudgePush } from "./handler.ts";

// The edge runtime keeps a request's background work alive past the response.
const runtime = (globalThis as {
  EdgeRuntime?: { waitUntil(work: Promise<unknown>): void };
}).EdgeRuntime;

Deno.serve(async (req) => {
  try {
    const { url, serviceRoleKey } = supabaseConfig();
    const db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const push: NudgePush = {
      dispatch: createDispatch(url, serviceRoleKey),
      defer: (work) => runtime ? runtime.waitUntil(work) : void work,
    };
    return await handleNudgeGroup(req, db, push);
  } catch (err) {
    return toErrorResponse(err);
  }
});
