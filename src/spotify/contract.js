/**
 * Spotify Phase B (docs/design/DOCK-CONTROLS.md sections 8.8 and 12): the
 * pure parts. Constants checked against Spotify's Web API documentation
 * (October 2026, after the February 2026 Development Mode changes), input
 * validators for every phone route, and mappers that turn Spotify objects
 * into the small shapes the phone gets. Nothing here does I/O.
 */

import { createHash } from "node:crypto";

export const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";
export const SPOTIFY_AUTHORIZE_URL = `${SPOTIFY_ACCOUNTS}/authorize`;
export const SPOTIFY_TOKEN_URL = `${SPOTIFY_ACCOUNTS}/api/token`;
export const SPOTIFY_API = "https://api.spotify.com/v1";

/**
 * Scopes (developer.spotify.com/documentation/web-api/concepts/scopes):
 * playback state + control, the queue (user-read-currently-playing),
 * Liked Songs read + save/remove (PUT/DELETE /me/library need
 * user-library-modify for tracks), playlists, and the profile.
 */
export const SPOTIFY_SCOPES = Object.freeze([
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-private",
]);

/** How long an authorize request (state + verifier) stays usable, single use. */
export const AUTH_STATE_TTL_MS = 10 * 60_000;
/** At most this many authorize requests wait at once (newest kept). */
export const AUTH_STATE_MAX = 8;

/** A Spotify client ID: 32 lowercase hex characters. */
export const CLIENT_ID_RE = /^[0-9a-f]{32}$/;
/** A Spotify ID: 22 base62 characters. */
export const SPOTIFY_ID_RE = /^[0-9A-Za-z]{22}$/;
/** Device IDs are opaque (documented as nullable strings, no format); in practice hex. */
export const DEVICE_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;
export const SEARCH_MAX_Q = 100;
/** GET /search: `limit` 0..10 (default 5) since February 2026; `offset` 0..1000. */
export const SEARCH_MAX_LIMIT = 10;
export const SEARCH_MAX_OFFSET = 1000;
/** GET /me/playlists and /me/tracks: `limit` 1..50, `offset` up to 100000. */
export const PAGE_MAX_LIMIT = 50;
export const PAGE_MAX_OFFSET = 100_000;
export const SEARCH_TYPES = Object.freeze(["track", "artist", "album", "playlist"]);
const SEARCH_ALIASES = Object.freeze({ songs: "track", song: "track", tracks: "track", artists: "artist", albums: "album", playlists: "playlist" });

/**
 * Hosts Spotify serves Web API images from. i.scdn.co is the one Spotify's
 * reference shows; the others are the playlist mosaic and uploaded-cover
 * hosts, each checked to resolve to Spotify's CDN (spotify.com CNAMEs).
 */
export const SPOTIFY_IMAGE_HOSTS = Object.freeze([
  "i.scdn.co",
  "mosaic.scdn.co",
  "image-cdn-ak.spotifycdn.com",
  "image-cdn-fa.spotifycdn.com",
]);
/** Largest edge the image route aims for. */
export const SPOTIFY_IMAGE_PX = 300;

export const validClientId = (v) => typeof v === "string" && CLIENT_ID_RE.test(v);
export const validSpotifyId = (v) => typeof v === "string" && SPOTIFY_ID_RE.test(v);
export const validDeviceId = (v) => typeof v === "string" && DEVICE_ID_RE.test(v);

/** `{ type, id }` for a `spotify:<type>:<22 base62>` URI of an allowed type, else null. */
export function parseSpotifyUri(value, types) {
  if (typeof value !== "string" || value.length > 64) return null;
  const m = /^spotify:([a-z]+):([0-9A-Za-z]{22})$/.exec(value);
  if (!m || !types.includes(m[1])) return null;
  return { type: m[1], id: m[2], uri: value };
}

/** The redirect URI the user registers: the loopback IP literal, never "localhost". */
export function redirectUriFor(port) {
  return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}/api/spotify/callback` : null;
}

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** S256 code challenge: base64url(sha256(verifier)), unpadded. */
export function codeChallenge(verifier) {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}
/** A 64-character verifier (43..128 allowed) from [A-Za-z0-9-_]. */
export function newVerifier(randomBytes) {
  return base64url(randomBytes(48));
}

/** The authorize URL. Every value is built by the host. */
export function authorizeUrl({ clientId, redirectUri, state, challenge, scopes = SPOTIFY_SCOPES }) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: scopes.join(" "),
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${q.toString()}`;
}

/** Strict integer query parameter: absent → fallback, otherwise min..max or an error. */
export function intParam(params, name, { min, max, fallback }) {
  const raw = params.get(name);
  if (raw === null || raw === "") return { ok: true, value: fallback };
  if (!/^\d{1,7}$/.test(raw)) return { ok: false, error: `${name} must be an integer` };
  const value = Number(raw);
  if (value < min || value > max) return { ok: false, error: `${name} must be ${min}..${max}` };
  return { ok: true, value };
}

/** `{ ok, offset, limit }` for paged library routes. */
export function pageParams(params, { maxLimit = PAGE_MAX_LIMIT, maxOffset = PAGE_MAX_OFFSET, defaultLimit = 50 } = {}) {
  const offset = intParam(params, "offset", { min: 0, max: maxOffset, fallback: 0 });
  if (!offset.ok) return offset;
  const limit = intParam(params, "limit", { min: 1, max: maxLimit, fallback: Math.min(defaultLimit, maxLimit) });
  if (!limit.ok) return limit;
  return { ok: true, offset: offset.value, limit: limit.value };
}

/** GET /api/spotify/search: `q` 1..100 chars, `types` from the four sections. */
export function searchParams(params) {
  const q = String(params.get("q") ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!q) return { ok: false, error: "q is required" };
  if (q.length > SEARCH_MAX_Q) return { ok: false, error: `q must be at most ${SEARCH_MAX_Q} characters` };
  const rawTypes = params.get("types") ?? params.get("type");
  let types = [...SEARCH_TYPES];
  if (rawTypes !== null && rawTypes !== "") {
    if (rawTypes.length > 100) return { ok: false, error: "unknown type" };
    const wanted = [];
    for (const part of rawTypes.split(",")) {
      const name = part.trim().toLowerCase();
      const type = SEARCH_TYPES.includes(name) ? name : SEARCH_ALIASES[name];
      if (!type) return { ok: false, error: "unknown type" };
      if (!wanted.includes(type)) wanted.push(type);
    }
    types = SEARCH_TYPES.filter((t) => wanted.includes(t));
  }
  const page = pageParams(params, { maxLimit: SEARCH_MAX_LIMIT, maxOffset: SEARCH_MAX_OFFSET, defaultLimit: SEARCH_MAX_LIMIT });
  if (!page.ok) return page;
  return { ok: true, q, types, offset: page.offset, limit: page.limit };
}

/**
 * POST /api/spotify/play `{ uri?, contextUri?, deviceId? }`:
 * a track/episode URI plays it; an album/playlist/artist context plays that
 * (with `uri` as the starting item for an album or playlist); neither resumes.
 */
export function validatePlay(body) {
  const out = {};
  if (body.uri !== undefined && body.uri !== null) {
    const item = parseSpotifyUri(body.uri, ["track", "episode"]);
    if (!item) return { ok: false, error: "uri must be a Spotify track or episode URI" };
    out.uri = item.uri;
  }
  if (body.contextUri !== undefined && body.contextUri !== null) {
    const ctx = parseSpotifyUri(body.contextUri, ["album", "playlist", "artist"]);
    if (!ctx) return { ok: false, error: "contextUri must be a Spotify album, playlist or artist URI" };
    if (out.uri && ctx.type === "artist") return { ok: false, error: "an artist context cannot start at a uri" };
    out.contextUri = ctx.uri;
  }
  const device = optionalDevice(body);
  if (!device.ok) return device;
  return { ok: true, ...out, deviceId: device.deviceId };
}

export function validateQueue(body) {
  const item = parseSpotifyUri(body.uri, ["track", "episode"]);
  if (!item) return { ok: false, error: "uri must be a Spotify track or episode URI" };
  const device = optionalDevice(body);
  if (!device.ok) return device;
  return { ok: true, uri: item.uri, deviceId: device.deviceId };
}

export function validateTransfer(body) {
  if (!validDeviceId(body.deviceId)) return { ok: false, error: "deviceId is invalid" };
  if (body.play !== undefined && typeof body.play !== "boolean") return { ok: false, error: "play must be a boolean" };
  return { ok: true, deviceId: body.deviceId, play: body.play };
}

export function validateLike(body) {
  if (!validSpotifyId(body.trackId)) return { ok: false, error: "trackId must be a Spotify track ID" };
  if (typeof body.liked !== "boolean") return { ok: false, error: "liked must be a boolean" };
  return { ok: true, trackId: body.trackId, liked: body.liked };
}

function optionalDevice(body) {
  if (body.deviceId === undefined || body.deviceId === null) return { ok: true, deviceId: undefined };
  if (!validDeviceId(body.deviceId)) return { ok: false, error: "deviceId is invalid" };
  return { ok: true, deviceId: body.deviceId };
}

// ---------------------------------------------------------------------------
// Images: opaque keys per Spotify entity, URLs only from Spotify's CDN.

/** Stable image key for an entity URI (playlist, album, artist): 32 hex. */
export function spotifyImageKey(uri) {
  return createHash("sha256").update(`spotify-image\u0000${uri}`).digest("hex").slice(0, 32);
}

/** The URL when it is an https URL on an allowlisted Spotify image host, else null. */
export function spotifyImageUrl(value) {
  if (typeof value !== "string" || value.length > 1024) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !SPOTIFY_IMAGE_HOSTS.includes(url.hostname) || url.port || url.username || url.password) return null;
  return url.href;
}

/**
 * From Spotify's `images` (up to three, largest first, sizes nullable): the
 * largest whose edge is at most `px`, else the smallest; only allowlisted URLs.
 */
export function pickImage(images, px = SPOTIFY_IMAGE_PX) {
  if (!Array.isArray(images)) return null;
  const usable = images
    .filter((img) => img && spotifyImageUrl(img.url))
    .map((img) => ({ url: spotifyImageUrl(img.url), edge: Math.max(Number(img.width) || 0, Number(img.height) || 0) || null }));
  if (!usable.length) return null;
  const fitting = usable.filter((img) => img.edge !== null && img.edge <= px).sort((a, b) => b.edge - a.edge);
  if (fitting.length) return fitting[0].url;
  const sized = usable.filter((img) => img.edge !== null).sort((a, b) => a.edge - b.edge);
  return (sized[0] ?? usable[usable.length - 1]).url;
}

// ---------------------------------------------------------------------------
// Mappers. `image(uri, images)` registers an image and returns its key or null.

const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

function artistRef(a) {
  if (!a || typeof a !== "object") return null;
  return { id: validSpotifyId(a.id) ? a.id : null, uri: str(a.uri, 64), name: str(a.name) ?? "" };
}

export function mapTrack(t, image) {
  if (!t || typeof t !== "object") return null;
  if (t.type === "episode") {
    const show = t.show && typeof t.show === "object" ? t.show : {};
    return {
      type: "episode",
      id: validSpotifyId(t.id) ? t.id : null,
      uri: str(t.uri, 64),
      name: str(t.name) ?? "",
      show: str(show.name),
      durationMs: int(t.duration_ms),
      image: validSpotifyId(t.id) ? image(`spotify:episode:${t.id}`, t.images ?? show.images) : null,
    };
  }
  const album = t.album && typeof t.album === "object" ? t.album : null;
  const albumUri = album && validSpotifyId(album.id) ? `spotify:album:${album.id}` : null;
  return {
    type: "track",
    id: validSpotifyId(t.id) ? t.id : null,
    uri: str(t.uri, 64),
    name: str(t.name) ?? "",
    artists: Array.isArray(t.artists) ? t.artists.map(artistRef).filter(Boolean).slice(0, 8) : [],
    album: album ? { id: validSpotifyId(album.id) ? album.id : null, uri: albumUri, name: str(album.name) ?? "" } : null,
    durationMs: int(t.duration_ms),
    explicit: t.explicit === true,
    playable: t.is_playable !== false && t.is_local !== true,
    image: albumUri ? image(albumUri, album.images) : null,
  };
}

export function mapPlaylist(p, image) {
  if (!p || typeof p !== "object" || !validSpotifyId(p.id)) return null;
  const uri = `spotify:playlist:${p.id}`;
  const owner = p.owner && typeof p.owner === "object" ? p.owner : {};
  // February 2026: `tracks` became `items` (track count in `items.total`).
  const total = int(p.items?.total) ?? int(p.tracks?.total);
  return {
    id: p.id,
    uri,
    name: str(p.name) ?? "",
    owner: { id: str(owner.id, 128), name: str(owner.display_name) },
    tracks: total,
    collaborative: p.collaborative === true,
    image: image(uri, p.images),
  };
}

export function mapAlbum(a, image) {
  if (!a || typeof a !== "object" || !validSpotifyId(a.id)) return null;
  const uri = `spotify:album:${a.id}`;
  return {
    id: a.id,
    uri,
    name: str(a.name) ?? "",
    artists: Array.isArray(a.artists) ? a.artists.map(artistRef).filter(Boolean).slice(0, 8) : [],
    tracks: int(a.total_tracks),
    releaseDate: str(a.release_date, 16),
    image: image(uri, a.images),
  };
}

export function mapArtist(a, image) {
  if (!a || typeof a !== "object" || !validSpotifyId(a.id)) return null;
  const uri = `spotify:artist:${a.id}`;
  return { id: a.id, uri, name: str(a.name) ?? "", image: image(uri, a.images) };
}

export function mapDevice(d) {
  if (!d || typeof d !== "object") return null;
  return {
    id: validDeviceId(d.id) ? d.id : null,
    name: str(d.name) ?? "",
    type: str(d.type, 40),
    active: d.is_active === true,
    restricted: d.is_restricted === true,
    privateSession: d.is_private_session === true,
    volume: Number.isInteger(d.volume_percent) ? d.volume_percent : null,
    supportsVolume: d.supports_volume === true,
  };
}

/** GET /me/player (200) to the phone's playback summary; 204 → null. */
export function mapPlayback(p, image) {
  if (!p || typeof p !== "object") return null;
  const ctx = p.context && typeof p.context === "object" ? p.context : null;
  return {
    device: mapDevice(p.device),
    playing: p.is_playing === true,
    item: mapTrack(p.item, image),
    context: ctx ? { type: str(ctx.type, 20), uri: str(ctx.uri, 64) } : null,
    progressMs: int(p.progress_ms),
    shuffle: p.shuffle_state === true,
    repeat: ["off", "track", "context"].includes(p.repeat_state) ? p.repeat_state : "off",
  };
}

/** A Spotify paging object to `{ items, total, offset, limit, next }`. */
export function mapPage(page, mapItem, { offset, limit }) {
  const items = Array.isArray(page?.items) ? page.items.map(mapItem).filter(Boolean) : [];
  return {
    items,
    total: int(page?.total) ?? items.length,
    offset,
    limit,
    next: typeof page?.next === "string" && page.next.length > 0,
  };
}
