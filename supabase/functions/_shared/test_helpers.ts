/**
 * Helpers for the *_integration_test.ts files, which run the real handlers against the
 * local Supabase stack (`supabase start`). They are excluded from `deno task check` and
 * run with `deno task test:integration`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { toErrorResponse } from "./http.ts";
import type { Ai } from "./openai.ts";

/**
 * Runs a handler the way index.ts does, turning a thrown HttpError into the response the
 * client would actually receive. Without this a test would assert on exceptions that
 * never reach production in that form.
 */
export async function invoke(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
}

// Local-stack defaults. These are the CLI's fixed development keys, not secrets.
const LOCAL_URL = "http://127.0.0.1:54321";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

export const SEED_PLAN_ID = "00000000-0000-0000-0000-0000000000a1";

const url = () => Deno.env.get("SUPABASE_URL") ?? LOCAL_URL;

export function serviceClient(): SupabaseClient {
  return createClient(
    url(),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? LOCAL_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/**
 * Signing in must happen on its own client. supabase-js puts the signed-in user's token
 * in the Authorization header of every later request on that client, so signing in on the
 * service client would silently demote it to that user and make RLS apply to the fixtures.
 */
function anonClient(): SupabaseClient {
  return createClient(
    url(),
    Deno.env.get("SUPABASE_ANON_KEY") ?? LOCAL_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export interface TestUser {
  id: string;
  token: string;
}

/** Creates a confirmed user and signs in, returning a real session token. */
export async function createTestUser(db: SupabaseClient, name: string): Promise<TestUser> {
  const email = `${name}-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();

  const { data: created, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (error || !created.user) throw new Error(`could not create test user: ${error?.message}`);

  const { data: session, error: signInError } = await anonClient().auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !session.session) {
    throw new Error(`could not sign in test user: ${signInError?.message}`);
  }

  return { id: created.user.id, token: session.session.access_token };
}

export async function deleteTestUsers(db: SupabaseClient, users: TestUser[]): Promise<void> {
  for (const user of users) {
    await db.auth.admin.deleteUser(user.id);
  }
}

export function post(body: unknown, token?: string): Request {
  return new Request("http://local/fn", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** An Ai stub. `flagged` decides moderation; nothing reaches the network. */
export function fakeAi(options: { flagged?: boolean } = {}): Ai & { generateCalls: number } {
  const ai = {
    generateCalls: 0,
    moderate: () => Promise.resolve({ flagged: options.flagged ?? false }),
    generateJson: (_prompt: string) => {
      ai.generateCalls++;
      return Promise.resolve({
        sentiment_tag: "hopeful",
        translations: { es: "texto traducido" },
        response: "Thank you for sharing this.",
      });
    },
    generateText: (_prompt: string) => {
      ai.generateCalls++;
      return Promise.resolve("generated");
    },
  };
  return ai;
}
