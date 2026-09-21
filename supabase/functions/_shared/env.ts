/** Environment access that fails loudly at startup rather than mid-request. */
import { HttpError } from "./http.ts";

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    // Never include the value; only the name of what is missing.
    throw new HttpError(500, `Missing required configuration: ${name}`);
  }
  return value;
}

export function supabaseConfig() {
  return {
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}
