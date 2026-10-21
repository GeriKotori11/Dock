/**
 * HTTP side of Spotify Phase B: the phone routes (paired session), the
 * loopback callback guard and the small pages the browser shows after login.
 * server.js wires these in; all Spotify logic lives in account.js.
 */

import { createHash } from "node:crypto";
import { isLoopback } from "../auth.js";
import { SpotifyError } from "./account.js";
import { pageParams, searchParams, validatePlay, validateQueue, validateTransfer, validateLike, validSpotifyId } from "./contract.js";

const IMAGE_KEY_RE = /^[0-9a-f]{32}$/;

/**
 * Why a request may not reach GET /api/spotify/callback, or null. The
 * callback is the user's own browser on this computer coming back from
 * accounts.spotify.com: a top-level navigation from a loopback address to the
 * 127.0.0.1 literal (Spotify only accepts that, never "localhost"). A page
 * elsewhere could aim an <img>, a fetch or a frame at it, so anything that is
 * not a document navigation is refused. The single-use `state` is what proves
 * the navigation belongs to a login this host started.
 */
export function callbackProblem(req, remote = req?.socket?.remoteAddress) {
  if (req.method !== "GET") return { status: 405, error: "method not allowed" };
  if (!isLoopback(remote)) return { status: 403, error: "local only" };
  const host = String(req.headers.host || "");
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(host)) return { status: 403, error: "local only" };
  const mode = req.headers["sec-fetch-mode"];
  const dest = req.headers["sec-fetch-dest"];
  if (mode !== undefined && mode !== "navigate") return { status: 403, error: "cross-site request" };
  if (dest !== undefined && dest !== "document") return { status: 403, error: "cross-site request" };
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return { status: 403, error: "cross-site request" };
  return null;
}

const PAGE_TEXT = Object.freeze({
  connected: "Connected. You can close this tab.",
  expired: "This Spotify sign-in has expired or was already used. Start again from WinDock.",
  access_denied: "Spotify was not connected because access was not allowed. You can close this tab.",
  invalid_client: "Spotify did not accept the Client ID. Check it on the WinDock page on this computer.",
  redirect_mismatch: "The redirect URI does not match the one registered in your Spotify app. Check it on the WinDock page on this computer.",
  unavailable: "Spotify could not be reached. Try again from WinDock.",
  generic: "Spotify could not be connected. Try again from WinDock.",
  forbidden: "This page only works in a browser on this computer.",
});

const PAGE_STYLE = "body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem}";
const STYLE_HASH = createHash("sha256").update(PAGE_STYLE).digest("base64");

/** Headers for the callback pages: nothing loads, nothing frames, nothing leaks the URL. */
export const CALLBACK_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

/** The page for an outcome: `connected` or an error code (constant text only). */
export function callbackPage(outcome) {
  const text = PAGE_TEXT[outcome] ?? PAGE_TEXT.generic;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="light dark"><title>WinDock · Spotify</title><style>${PAGE_STYLE}</style></head>`
    + `<body><p>${text}</p></body></html>\n`;
}

export function sendCallbackPage(res, status, outcome) {
  const body = callbackPage(outcome);
  res.writeHead(status, { ...CALLBACK_HEADERS, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * The phone routes under /api/spotify/ (DOCK-CONTROLS 8.8), after the
 * session check and the same-origin check for mutating methods. Returns
 * false when the path is not one of them.
 */
export async function handleSpotifyRoute({ req, res, path, url, account, redirectUri, sendJson, readJsonBody, isJsonRequest }) {
  const route = `${req.method} ${path}`;
  const known = new Set([
    "GET /api/spotify/status", "POST /api/spotify/connect", "DELETE /api/spotify/account",
    "GET /api/spotify/playlists", "GET /api/spotify/liked", "GET /api/spotify/search", "GET /api/spotify/devices",
    "POST /api/spotify/play", "POST /api/spotify/queue", "GET /api/spotify/queue", "POST /api/spotify/transfer",
    "POST /api/spotify/like", "GET /api/spotify/like", "GET /api/spotify/image",
  ]);
  if (!known.has(route)) return false;
  const send = (status, body, headers) => sendJson(res, status, body, headers);
  const bad = (error) => send(400, { error });
  try {
    if (route === "GET /api/spotify/status") return send(200, await account.phoneStatus());
    if (req.method === "POST" && !isJsonRequest(req)) return send(415, { error: "content-type must be application/json" });
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    await account.init();
    if (!account.configured) return send(501, { error: "spotify not configured" });
    switch (route) {
      case "POST /api/spotify/connect":
        // Opens the browser on the computer, never on the phone.
        return send(200, await account.beginConnect(redirectUri()));
      case "DELETE /api/spotify/account":
        await account.disconnect(null);
        return send(200, { ok: true, connected: false });
      case "GET /api/spotify/playlists":
      case "GET /api/spotify/liked": {
        const page = pageParams(url.searchParams);
        if (!page.ok) return bad(page.error);
        return send(200, await (path.endsWith("/liked") ? account.liked(page) : account.playlists(page)));
      }
      case "GET /api/spotify/search": {
        const q = searchParams(url.searchParams);
        if (!q.ok) return bad(q.error);
        return send(200, await account.search(q));
      }
      case "GET /api/spotify/devices":
        return send(200, await account.devices());
      case "POST /api/spotify/play": {
        const checked = validatePlay(body);
        if (!checked.ok) return bad(checked.error);
        return send(200, await account.play(checked));
      }
      case "POST /api/spotify/queue": {
        const checked = validateQueue(body);
        if (!checked.ok) return bad(checked.error);
        return send(200, await account.queue(checked));
      }
      case "GET /api/spotify/queue":
        return send(200, await account.upNext());
      case "POST /api/spotify/transfer": {
        const checked = validateTransfer(body);
        if (!checked.ok) return bad(checked.error);
        return send(200, await account.transfer(checked));
      }
      case "POST /api/spotify/like": {
        const checked = validateLike(body);
        if (!checked.ok) return bad(checked.error);
        return send(200, await account.like(checked));
      }
      case "GET /api/spotify/like": {
        const trackId = url.searchParams.get("trackId");
        if (!validSpotifyId(trackId)) return bad("trackId must be a Spotify track ID");
        return send(200, await account.isLiked(trackId));
      }
      case "GET /api/spotify/image": {
        const key = url.searchParams.get("key");
        if (typeof key !== "string" || !IMAGE_KEY_RE.test(key)) return bad("invalid key");
        const art = await account.image(key);
        if (!art) return send(404, { error: "no image" });
        res.writeHead(200, {
          "content-type": art.mime,
          "content-length": art.bytes.length,
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
        });
        res.end(art.bytes);
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    if (err instanceof SpotifyError) return send(err.status, err.body, err.headers);
    throw err;
  }
}
