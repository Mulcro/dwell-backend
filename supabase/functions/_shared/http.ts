/** JSON/error plumbing shared by every function. */

/** An error with an HTTP status. Anything else that escapes a handler becomes a 500. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Turns a thrown error into a response. Only HttpError messages reach the client;
 * anything else is logged and reported as a generic 500, so upstream API bodies and
 * stack traces never leak.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message }, err.status);
  }
  console.error("unhandled error", err);
  return json({ error: "Internal error" }, 500);
}

export async function readJson<T>(req: Request): Promise<T> {
  if (req.method !== "POST") {
    throw new HttpError(405, "Method not allowed");
  }
  try {
    return await req.json() as T;
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

/** Reads a required string field, rejecting empty and non-string values alike. */
export function requireString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

export function optionalInt(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}
