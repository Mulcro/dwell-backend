/**
 * GET /yv-callback  -- the redirect target registered with YouVersion.
 *
 * Two problems are solved here, and they are unrelated to each other.
 *
 * 1. YouVersion only accepts https redirect URIs; a custom scheme is refused at
 *    registration. But an https URL cannot reach an iOS app without Universal Links,
 *    which needs a domain we own, an apple-app-site-association file and an Apple Team
 *    ID. This is an https URL on a domain we already control that 302s to the app's
 *    scheme, which ASWebAuthenticationSession catches.
 *
 * 2. Their sign-in is a THREE-step flow, not the usual two. The first callback carries
 *    only `state` -- deliberately, so identity never rides on a browser-facing URL. The
 *    state must be replayed to /auth/callback, which answers with a redirect that finally
 *    carries `code`. Doing that replay here keeps the whole dance server-side, so the app
 *    only ever sees a normal `?code=` arrival.
 */
const APP_SCHEME_URL = "dwell://auth-callback";
const YV_CALLBACK = "https://api.youversion.com/auth/callback";

/** Only what the OAuth response is allowed to carry. */
const FORWARDED = ["code", "state", "error", "error_description", "granted_permissions"];

export type DebugRecorder = (leg: string, paramNames: string[]) => void;

export function handleYvCallback(
  req: Request,
  destination = APP_SCHEME_URL,
  replayUrl = YV_CALLBACK,
  record?: DebugRecorder,
): Response {
  const incoming = new URL(req.url).searchParams;
  const code = incoming.get("code");
  const error = incoming.get("error");
  const state = incoming.get("state");

  // Step two: state came back without a code, and nothing failed. Replay it to
  // YouVersion, which redirects straight back here with the code attached.
  if (!code && !error && state) {
    const replay = new URL(replayUrl);

    // Everything we were handed goes back, not just `state`. Their flow carries its own
    // session context (a `__yvii` identifier appears mid-flow), and dropping anything we
    // do not recognise gets the replay rejected as an invalid state. This is safe to do
    // here precisely because the destination is hardcoded to YouVersion's own endpoint --
    // the whitelist below exists for the app-bound leg, where it is doing a different job.
    for (const [key, value] of incoming) replay.searchParams.set(key, value);

    // Names only; these values are live sign-in credentials.
    record?.("replay", [...incoming.keys()]);
    return redirect(replay.toString(), "Finishing sign-in…");
  }

  // Step three: the code is here (or the attempt failed). Hand it to the app.
  const forwarded = new URLSearchParams();
  for (const key of FORWARDED) {
    const value = incoming.get(key);
    if (value !== null) forwarded.set(key, value);
  }

  record?.(code ? "code" : error ? "error" : "bare", [...incoming.keys()]);

  const target = forwarded.size > 0 ? `${destination}?${forwarded}` : destination;
  return redirect(target, "Returning to Dwell…");
}

/**
 * 302 with a small body: if the OS does not follow the scheme on its own, the page still
 * offers a tap target rather than a blank screen.
 */
function redirect(target: string, message: string): Response {
  const safe = escapeHtml(target);
  return new Response(
    `<!doctype html><meta charset="utf-8">` +
      `<meta http-equiv="refresh" content="0;url=${safe}">` +
      `<p>${message} <a href="${safe}">tap here</a> if nothing happens.</p>`,
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
