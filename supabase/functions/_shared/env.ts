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

/**
 * Every key that identifies a trusted server-side caller.
 *
 * Supabase injects the legacy `service_role` JWT and, on projects using the newer API
 * keys, a `SUPABASE_SECRET_KEYS` list. A caller may present any of them, so all are
 * accepted; the value is never logged.
 */
export function serviceRoleKeys(): string[] {
  const keys = new Set<string>();

  const primary = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (primary) keys.add(primary);

  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const values = Array.isArray(parsed) ? parsed : Object.values(parsed);
      for (const v of values) {
        if (typeof v === "string" && v) keys.add(v);
        else if (
          v && typeof v === "object" &&
          typeof (v as { api_key?: string }).api_key === "string"
        ) {
          keys.add((v as { api_key: string }).api_key);
        }
      }
    } catch {
      // Not JSON: treat it as a comma-separated list.
      for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (trimmed) keys.add(trimmed);
      }
    }
  }

  return [...keys];
}
