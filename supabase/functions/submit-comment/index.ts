import { createClient } from "@supabase/supabase-js";
import { createDispatch } from "../_shared/dispatch.ts";
import { requireEnv, supabaseConfig } from "../_shared/env.ts";
import { toErrorResponse } from "../_shared/http.ts";
import { createAi } from "../_shared/openai.ts";
import { handleSubmitComment, type ReplyPush, type Visibility } from "./handler.ts";

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

    // Asked as the caller, so the unlock rule comes from the RLS policy already written
    // rather than a second copy of it living here.
    const visibility: Visibility = {
      async canSee(reflectionId, token) {
        const asUser = createClient(url, requireEnv("SUPABASE_ANON_KEY"), {
          auth: { persistSession: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data } = await asUser
          .from("reflections")
          .select("id")
          .eq("id", reflectionId)
          .maybeSingle();
        return data !== null;
      },
    };

    // The author's push runs after the response, so it can never slow or fail a reply.
    const push: ReplyPush = {
      dispatch: createDispatch(url, serviceRoleKey),
      defer: (work) => runtime ? runtime.waitUntil(work) : void work,
    };

    return await handleSubmitComment(
      req,
      db,
      createAi(requireEnv("OPENAI_API_KEY")),
      visibility,
      undefined,
      push,
    );
  } catch (err) {
    return toErrorResponse(err);
  }
});
