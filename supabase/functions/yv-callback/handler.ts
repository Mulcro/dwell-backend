/**
 * GET /yv-callback?code=...&state=...
 *
 * Bounces YouVersion's redirect into the app.
 *
 * YouVersion only accepts https redirect URIs -- a custom scheme is rejected at
 * registration -- but an https URL cannot reach an iOS app without Universal Links,
 * which needs a domain we own, an apple-app-site-association file and an Apple Team ID.
 * This relay sidesteps all three: it is an https URL on a domain we already control, and
 * it 302s straight to the app's scheme, which ASWebAuthenticationSession catches.
 *
 * The destination is hardcoded on purpose. Taking it from a query parameter would make
 * this an open redirect that forwards a live authorization code anywhere.
 */
const APP_SCHEME_URL = "dwell://auth-callback";

/** Only what the OAuth response is allowed to carry. */
const FORWARDED = ["code", "state", "error", "error_description", "granted_permissions"];

export function handleYvCallback(req: Request, destination = APP_SCHEME_URL): Response {
  const incoming = new URL(req.url).searchParams;

  const forwarded = new URLSearchParams();
  for (const key of FORWARDED) {
    const value = incoming.get(key);
    if (value !== null) forwarded.set(key, value);
  }

  const target = forwarded.size > 0 ? `${destination}?${forwarded}` : destination;

  // 302 with a tiny body: if the OS does not follow the scheme automatically, the page
  // still offers a tap target rather than showing a blank screen.
  return new Response(
    `<!doctype html><meta charset="utf-8">` +
      `<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}">` +
      `<p>Returning to Dwell… <a href="${escapeHtml(target)}">tap here</a> if nothing happens.</p>`,
    {
      status: 302,
      headers: {
        Location: target,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
