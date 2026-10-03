/**
 * Calling one Edge Function from another, as the service role.
 *
 * The database has its own version of this (public.dispatch_edge_function); this is the
 * TypeScript side, used where a function must trigger another one directly.
 */
export type Dispatch = (name: string, body: unknown) => Promise<void>;

/** A follow-up that hangs must not hold its caller's cron tick hostage. */
const DISPATCH_TIMEOUT_MS = 10_000;

export function createDispatch(url: string, serviceRoleKey: string): Dispatch {
  return async (name, body) => {
    try {
      const res = await fetch(`${url}/functions/v1/${name}`, {
        method: "POST",
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.error(`dispatch ${name} failed`, res.status);
    } catch (err) {
      // A follow-up call failing must not roll back the state change that earned it.
      console.error(`dispatch ${name} threw`, err);
    }
  };
}
