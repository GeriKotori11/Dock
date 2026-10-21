/**
 * Spotify account on the host (DOCK-CONTROLS 8.8 and 12): the client ID
 * (host config), PKCE login with a loopback redirect, tokens in the OS secret
 * store with automatic refresh, and a narrow Web API proxy for the phone.
 *
 * The phone never sees a token. Tokens never reach a log line, an argv or a
 * response body. Every Spotify request goes to a fixed https origin with
 * redirects refused and a timeout.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import { imageInfo, ARTWORK_KEEP_PX, ARTWORK_MAX_BYTES } from "../platform/artwork.js";
import {
  SPOTIFY_API,
  SPOTIFY_TOKEN_URL,
  AUTH_STATE_TTL_MS,
  AUTH_STATE_MAX,
  SPOTIFY_IMAGE_PX,
  validClientId,
  codeChallenge,
  newVerifier,
  authorizeUrl,
  spotifyImageKey,
  spotifyImageUrl,
  pickImage,
  parseSpotifyUri,
  mapTrack,
  mapPlaylist,
  mapAlbum,
  mapArtist,
  mapDevice,
  mapPlayback,
  mapPage,
} from "./contract.js";

/** Refresh this long before the access token expires. */
export const REFRESH_AHEAD_MS = 5 * 60_000;
export const SPOTIFY_TIMEOUT_MS = 10_000;
/** Library pages (playlists, Liked Songs) are shared this long. */
export const LIBRARY_CACHE_MS = 60_000;
export const PLAYBACK_CACHE_MS = 2_000;
/** Longest Retry-After the host honours in memory (seconds beyond this are clamped). */
export const MAX_BACKOFF_MS = 60_000;
/** Spotify image URLs expire in under a day; re-resolve after this. */
export const IMAGE_URL_TTL_MS = 6 * 3600_000;
const IMAGE_REGISTRY_MAX = 2000;
const IMAGE_CACHE_MAX = 64;
const PROFILE_RETRY_MS = 60_000;

/** Error codes the host page and the phone understand. */
export const SPOTIFY_ERRORS = Object.freeze(["invalid_client", "redirect_mismatch", "access_denied", "disconnected", "exchange_failed", "unavailable"]);

/** An error that carries the exact HTTP answer for the phone. */
export class SpotifyError extends Error {
  constructor(status, body, headers = {}) {
    super(body?.error || "spotify error");
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}
const notConfigured = () => new SpotifyError(501, { error: "spotify not configured" });
const notConnected = () => new SpotifyError(409, { error: "spotify not connected" });
const disconnectedError = () => new SpotifyError(409, { error: "spotify disconnected" });
const unavailable = () => new SpotifyError(502, { error: "spotify unavailable" });
function rateLimited(waitMs) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  return new SpotifyError(429, { error: "rate limited", retryInMs: waitMs }, { "retry-after": String(seconds) });
}

/**
 * @param {object} opts
 * @param {{ load(): Promise<object>, save(c: object): Promise<object> }} opts.configStore
 * @param {() => { read, write, remove }} opts.tokenStore factory, called only once a client ID exists
 * @param {(url: string) => Promise<void>} opts.openUrl opens the authorize URL on this computer
 * @param {(bytes: Buffer, px: number) => Promise<{mime, bytes}|null>} [opts.fitImage]
 */
export function createSpotifyAccount({
  configStore,
  tokenStore: tokenStoreFactory,
  openUrl = async () => { throw new Error("no opener"); },
  fetchImpl = globalThis.fetch,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  fitImage = null,
  timeoutMs = SPOTIFY_TIMEOUT_MS,
  log = () => {},
  onChange = () => {},
} = {}) {
  let clientId = null;
  let initialized = null;
  let store = null;
  let tokens = null; // { accessToken, refreshToken, expiresAt, scope, clientId }
  let tokensLoaded = false;
  let tokensLoading = null;
  let refreshing = null;
  let profile = null; // { name, product }
  let profileAt = 0;
  let profileLoading = null;
  let premiumSeen = null; // learned from player answers when /me has no `product`
  let error = null;
  let backoffUntil = 0;
  const pending = new Map(); // state -> { verifier, redirectUri, clientId, expiresAt }
  const pageCache = new Map(); // key -> { at, value }
  let playbackCache = null;
  const images = new Map(); // key -> { uri, url, at }
  const imageBytes = new Map(); // key -> { mime, bytes }
  const imageInflight = new Map();

  let lastSignature = "";
  function changed() {
    const signature = JSON.stringify([feature(), error]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    try { onChange(); } catch { /* listeners never break the account */ }
  }

  function tokenStore() {
    if (!store) store = tokenStoreFactory();
    return store;
  }
  const connected = () => Boolean(clientId && tokens && tokens.clientId === clientId);

  async function loadTokens() {
    if (tokensLoaded || !clientId) return;
    if (!tokensLoading) {
      tokensLoading = Promise.resolve()
        .then(() => tokenStore().read())
        .then((value) => {
          tokens = validTokens(value) ? value : null;
          tokensLoaded = true;
        })
        .catch(() => { log("WinDock: could not read the Spotify sign-in from the secret store"); tokensLoaded = true; })
        .finally(() => { tokensLoading = null; });
    }
    await tokensLoading;
  }

  /** Read the client ID (and, when there is one, the stored tokens and profile). Idempotent. */
  function init() {
    if (!initialized) {
      initialized = (async () => {
        const config = await configStore.load();
        clientId = validClientId(config?.spotify?.clientId) ? config.spotify.clientId : null;
        if (clientId) {
          await loadTokens();
          if (connected()) refreshProfile().catch(() => {});
        }
        changed();
      })().catch(() => {});
    }
    return initialized;
  }

  function premium() {
    if (profile && typeof profile.product === "string") return profile.product === "premium";
    return premiumSeen;
  }

  /** `features.spotify.account` (DOCK-CONTROLS 7.1). */
  function feature() {
    if (!clientId) return { available: false };
    const on = connected();
    return {
      available: true,
      connected: on,
      premium: on ? premium() : null,
      name: on ? profile?.name ?? null : null,
      error,
    };
  }

  function status() {
    const on = connected();
    return {
      configured: Boolean(clientId),
      clientId,
      connected: on,
      account: on ? { name: profile?.name ?? null, premium: premium(), product: profile?.product ?? null } : null,
      error,
    };
  }

  function clearCaches() {
    pageCache.clear();
    playbackCache = null;
  }

  async function setClientId(next) {
    if (!validClientId(next)) throw new SpotifyError(400, { error: "clientId must be 32 lowercase hex characters" });
    await init();
    const config = await configStore.load();
    await configStore.save({ ...config, spotify: { clientId: next } });
    if (next !== clientId) {
      clientId = next;
      await loadTokens();
      // Tokens belong to the client that issued them.
      if (tokens && tokens.clientId !== next) await forget();
      error = null;
      profile = null;
      premiumSeen = null;
    }
    changed();
    return status();
  }

  async function forget() {
    tokens = null;
    tokensLoaded = true;
    profile = null;
    premiumSeen = null;
    clearCaches();
    imageBytes.clear();
    try {
      await tokenStore().remove();
    } catch {
      log("WinDock: could not remove the Spotify sign-in from the secret store");
    }
  }

  /** Disconnect (user action: no error; revoked/invalid: an error code). */
  async function disconnect(reason = null) {
    await init();
    await loadTokens();
    await forget();
    error = reason;
    changed();
    return status();
  }

  // ---- login (PKCE) ----

  function prunePending() {
    const at = now();
    for (const [state, entry] of pending) if (entry.expiresAt <= at) pending.delete(state);
    while (pending.size >= AUTH_STATE_MAX) pending.delete(pending.keys().next().value);
  }

  /** Start a login: a fresh state + verifier, then open the authorize URL on this computer. */
  async function beginConnect(redirectUri) {
    await init();
    if (!clientId) throw notConfigured();
    if (!redirectUri) throw new SpotifyError(503, { error: "port unknown" });
    prunePending();
    const verifier = newVerifier(randomBytes);
    const state = randomBytes(24).toString("base64url");
    pending.set(state, { verifier, redirectUri, clientId, expiresAt: now() + AUTH_STATE_TTL_MS });
    const url = authorizeUrl({ clientId, redirectUri, state, challenge: codeChallenge(verifier) });
    // A new attempt starts clean, so a repeat of the same error is visible as new.
    error = null;
    changed();
    try {
      await openUrl(url);
    } catch {
      throw new SpotifyError(502, { error: "could not open the browser" });
    }
    return { ok: true };
  }

  async function postToken(params) {
    let res;
    try {
      res = await fetchImpl(SPOTIFY_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(params).toString(),
      });
    } catch {
      return { status: 0, json: null };
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }

  /** Map a failed token answer to one of SPOTIFY_ERRORS. */
  function tokenErrorCode({ status, json }) {
    if (status === 0 || status >= 500) return "unavailable";
    const code = typeof json?.error === "string" ? json.error : "";
    const description = typeof json?.error_description === "string" ? json.error_description : "";
    if (code === "invalid_client") return "invalid_client";
    if (/redirect/i.test(description)) return "redirect_mismatch";
    return "exchange_failed";
  }

  function tokensFrom(json, previous) {
    if (!json || typeof json.access_token !== "string" || !json.access_token || json.access_token.length > 4096) return null;
    const refreshToken = typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previous?.refreshToken;
    if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 4096) return null;
    const expiresIn = Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 3600;
    return {
      accessToken: json.access_token,
      refreshToken,
      expiresAt: now() + expiresIn * 1000,
      scope: typeof json.scope === "string" ? json.scope.slice(0, 1000) : previous?.scope ?? "",
      clientId: previous?.clientId ?? clientId,
    };
  }

  /**
   * GET /api/spotify/callback, after the loopback/navigation checks in the
   * server: validates and spends the state, exchanges the code. Returns
   * `{ ok, error }`; never throws.
   */
  async function completeConnect(params, requestHost) {
    await init();
    prunePending();
    const state = params.get("state");
    const entry = typeof state === "string" && state.length <= 128 ? pending.get(state) : undefined;
    if (!entry) return { ok: false, error: "expired" };
    pending.delete(state); // single use, whatever happens next
    if (new URL(entry.redirectUri).host !== requestHost) return { ok: false, error: "expired" };
    const denied = params.get("error");
    if (denied !== null) {
      error = denied === "access_denied" ? "access_denied" : "exchange_failed";
      changed();
      return { ok: false, error };
    }
    const code = params.get("code");
    if (typeof code !== "string" || !/^[A-Za-z0-9._~-]{1,2048}$/.test(code)) {
      error = "exchange_failed";
      changed();
      return { ok: false, error };
    }
    if (entry.clientId !== clientId) return { ok: false, error: "expired" };
    const answer = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: entry.redirectUri,
      client_id: entry.clientId,
      code_verifier: entry.verifier,
    });
    const next = answer.status === 200 ? tokensFrom(answer.json, { clientId: entry.clientId }) : null;
    if (!next) {
      error = answer.status === 200 ? "exchange_failed" : tokenErrorCode(answer);
      log(`WinDock: Spotify sign-in failed (${error})`);
      changed();
      return { ok: false, error };
    }
    try {
      await tokenStore().write(next);
    } catch {
      log("WinDock: could not save the Spotify sign-in to the secret store");
      error = "exchange_failed";
      changed();
      return { ok: false, error };
    }
    tokens = next;
    tokensLoaded = true;
    error = null;
    profile = null;
    premiumSeen = null;
    clearCaches();
    await refreshProfile().catch(() => {});
    changed();
    log("WinDock: Spotify connected");
    return { ok: true };
  }

  // ---- tokens ----

  async function doRefresh() {
    const previous = tokens;
    if (!previous) throw notConnected();
    const answer = await postToken({ grant_type: "refresh_token", refresh_token: previous.refreshToken, client_id: previous.clientId });
    if (answer.status === 200) {
      const next = tokensFrom(answer.json, previous);
      if (!next) throw unavailable();
      tokens = next;
      try {
        await tokenStore().write(next);
      } catch {
        log("WinDock: could not save the refreshed Spotify sign-in");
      }
      return next;
    }
    const code = typeof answer.json?.error === "string" ? answer.json.error : "";
    if (answer.status === 400 && (code === "invalid_grant" || code === "invalid_client")) {
      await disconnect(code === "invalid_client" ? "invalid_client" : "disconnected");
      throw disconnectedError();
    }
    throw unavailable();
  }
  /** One refresh at a time; concurrent callers share it. */
  function refresh() {
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function accessToken() {
    await init();
    if (!clientId) throw notConfigured();
    await loadTokens();
    if (!connected()) throw error === "disconnected" ? disconnectedError() : notConnected();
    if (tokens.expiresAt - now() > REFRESH_AHEAD_MS) return tokens.accessToken;
    return (await refresh()).accessToken;
  }

  // ---- Web API ----

  async function api(method, path, { query, body, player = false } = {}) {
    let token = await accessToken();
    for (let attempt = 0; ; attempt += 1) {
      const wait = backoffUntil - now();
      if (wait > 0) throw rateLimited(wait);
      const url = new URL(SPOTIFY_API + path);
      for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
      let res;
      try {
        res = await fetchImpl(url.href, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          // Spotify wants a Content-Length on bodiless PUT/POST/DELETE.
          body: body !== undefined ? JSON.stringify(body) : method === "GET" ? undefined : "",
        });
      } catch {
        throw unavailable();
      }
      if (res.status === 401) {
        if (attempt === 0) {
          // Refresh once (unless another request already did), then retry.
          if (tokens && tokens.accessToken === token) await refresh();
          if (!connected()) throw disconnectedError();
          token = tokens.accessToken;
          continue;
        }
        await disconnect("disconnected");
        throw disconnectedError();
      }
      let json = null;
      const text = res.status === 204 ? "" : await res.text().catch(() => "");
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      if (res.status === 429) {
        const seconds = Number(res.headers?.get?.("retry-after"));
        const waitMs = Math.min(MAX_BACKOFF_MS, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000);
        backoffUntil = now() + waitMs;
        throw rateLimited(waitMs);
      }
      const reason = String(json?.error?.reason ?? "");
      const message = String(json?.error?.message ?? "");
      if (res.status === 403) {
        if (reason === "PREMIUM_REQUIRED" || /premium/i.test(message)) {
          if (premiumSeen !== false) { premiumSeen = false; changed(); }
          throw new SpotifyError(403, { error: "premium required" });
        }
        if (/regist|developer dashboard|not allowed/i.test(message)) throw new SpotifyError(403, { error: "spotify user not allowed" });
        throw new SpotifyError(403, { error: "spotify forbidden" });
      }
      if (res.status === 404) {
        if (player || reason === "NO_ACTIVE_DEVICE") throw new SpotifyError(409, { error: "no active device" });
        throw new SpotifyError(404, { error: "not found" });
      }
      if (res.status >= 400) {
        if (player && reason === "NO_ACTIVE_DEVICE") throw new SpotifyError(409, { error: "no active device" });
        if (res.status >= 500) throw unavailable();
        throw new SpotifyError(400, { error: "spotify rejected the request" });
      }
      if (player && method !== "GET" && premiumSeen !== true) { premiumSeen = true; changed(); }
      return { status: res.status, json };
    }
  }

  async function refreshProfile() {
    if (profileLoading) return profileLoading;
    profileLoading = (async () => {
      profileAt = now();
      const { json } = await api("GET", "/me");
      // `product` is deprecated and missing for Development Mode apps since
      // February 2026; then Premium is learned from player answers.
      profile = {
        name: typeof json?.display_name === "string" ? json.display_name.slice(0, 200) : null,
        product: typeof json?.product === "string" ? json.product.slice(0, 40) : null,
      };
      changed();
      return profile;
    })().finally(() => { profileLoading = null; });
    return profileLoading;
  }

  // ---- images ----

  /** Remember an entity's image; the key or null when it has none. */
  function registerImage(uri, list) {
    if (typeof uri !== "string" || !uri) return null;
    const key = spotifyImageKey(uri);
    const url = list === undefined ? null : pickImage(list);
    const prev = images.get(key);
    if (list !== undefined && !url && !prev?.url) return null;
    images.delete(key);
    images.set(key, { uri, url: url ?? prev?.url ?? null, at: url ? now() : prev?.at ?? 0 });
    while (images.size > IMAGE_REGISTRY_MAX) images.delete(images.keys().next().value);
    return key;
  }
  /** A tile's image key, resolvable later through its URI. */
  function imageKeyFor(uri) {
    return registerImage(uri, undefined);
  }

  async function resolveImageUrl(uri) {
    const ref = parseSpotifyUri(uri, ["playlist", "album", "artist", "episode", "show", "track"]);
    if (!ref) return null;
    if (ref.type === "playlist") return pickImage((await api("GET", `/playlists/${ref.id}/images`)).json);
    if (ref.type === "track") return pickImage((await api("GET", `/tracks/${ref.id}`)).json?.album?.images);
    return pickImage((await api("GET", `/${ref.type}s/${ref.id}`)).json?.images);
  }

  async function fetchImageBytes(url) {
    if (!spotifyImageUrl(url)) return null;
    let res;
    try {
      res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "image/jpeg, image/png" } });
    } catch {
      return null;
    }
    if (!res?.ok) return null;
    const declared = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > ARTWORK_MAX_BYTES) return null;
    let bytes;
    try {
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
    if (bytes.length > ARTWORK_MAX_BYTES) return null;
    const info = imageInfo(bytes);
    if (!info) return null;
    const edge = Math.max(info.width, info.height);
    if (edge <= SPOTIFY_IMAGE_PX) return { mime: info.mime, bytes };
    if (typeof fitImage === "function") {
      const fitted = await fitImage(bytes, SPOTIFY_IMAGE_PX).catch(() => null);
      const out = fitted && Buffer.isBuffer(fitted.bytes) ? imageInfo(fitted.bytes) : null;
      if (out && Math.max(out.width, out.height) <= SPOTIFY_IMAGE_PX) return { mime: out.mime, bytes: fitted.bytes };
    }
    return edge <= ARTWORK_KEEP_PX ? { mime: info.mime, bytes } : null;
  }

  /** `{ mime, bytes }` for an image key, or null. */
  function image(key) {
    const hit = imageBytes.get(key);
    if (hit) {
      imageBytes.delete(key);
      imageBytes.set(key, hit);
      return Promise.resolve(hit);
    }
    if (imageInflight.has(key)) return imageInflight.get(key);
    const entry = images.get(key);
    if (!entry) return Promise.resolve(null);
    const pendingImage = (async () => {
      let art = null;
      if (entry.url && now() - entry.at < IMAGE_URL_TTL_MS) art = await fetchImageBytes(entry.url);
      if (!art) {
        const url = await resolveImageUrl(entry.uri).catch(() => null);
        if (url) {
          entry.url = url;
          entry.at = now();
          art = await fetchImageBytes(url);
        }
      }
      if (art) {
        imageBytes.set(key, art);
        while (imageBytes.size > IMAGE_CACHE_MAX) imageBytes.delete(imageBytes.keys().next().value);
      }
      return art;
    })().finally(() => imageInflight.delete(key));
    imageInflight.set(key, pendingImage);
    return pendingImage;
  }

  // ---- phone routes ----

  async function cached(key, ms, load) {
    const hit = pageCache.get(key);
    if (hit && now() - hit.at < ms) return hit.value;
    const value = await load();
    pageCache.set(key, { at: now(), value });
    while (pageCache.size > 200) pageCache.delete(pageCache.keys().next().value);
    return value;
  }

  const playlists = ({ offset, limit }) => cached(`playlists:${offset}:${limit}`, LIBRARY_CACHE_MS, async () => {
    const { json } = await api("GET", "/me/playlists", { query: { offset, limit } });
    return mapPage(json, (p) => mapPlaylist(p, registerImage), { offset, limit });
  });

  const liked = ({ offset, limit }) => cached(`liked:${offset}:${limit}`, LIBRARY_CACHE_MS, async () => {
    const { json } = await api("GET", "/me/tracks", { query: { offset, limit } });
    return mapPage(json, (row) => mapTrack(row?.track, registerImage), { offset, limit });
  });

  async function search({ q, types, offset, limit }) {
    const { json } = await api("GET", "/search", { query: { q, type: types.join(","), offset, limit } });
    const section = (name, mapItem) => (json?.[name] ? mapPage(json[name], mapItem, { offset, limit }) : undefined);
    return {
      q,
      tracks: section("tracks", (t) => mapTrack(t, registerImage)),
      artists: section("artists", (a) => mapArtist(a, registerImage)),
      albums: section("albums", (a) => mapAlbum(a, registerImage)),
      playlists: section("playlists", (p) => mapPlaylist(p, registerImage)),
    };
  }

  async function devices() {
    const { json } = await api("GET", "/me/player/devices");
    return { devices: Array.isArray(json?.devices) ? json.devices.map(mapDevice).filter(Boolean) : [] };
  }

  async function playback({ fresh = false } = {}) {
    if (!fresh && playbackCache && now() - playbackCache.at < PLAYBACK_CACHE_MS) return playbackCache.value;
    const { status: code, json } = await api("GET", "/me/player", { query: { additional_types: "track,episode" } });
    const value = code === 204 ? null : mapPlayback(json, registerImage);
    playbackCache = { at: now(), value };
    return value;
  }

  async function play({ uri, contextUri, deviceId }) {
    let body;
    if (contextUri) body = { context_uri: contextUri, ...(uri ? { offset: { uri } } : {}) };
    else if (uri) body = { uris: [uri] };
    await api("PUT", "/me/player/play", { query: { device_id: deviceId }, body, player: true });
    playbackCache = null;
    return { ok: true };
  }

  async function queue({ uri, deviceId }) {
    await api("POST", "/me/player/queue", { query: { uri, device_id: deviceId }, player: true });
    return { ok: true };
  }

  async function upNext() {
    const { json } = await api("GET", "/me/player/queue", { player: false });
    return {
      currentlyPlaying: mapTrack(json?.currently_playing, registerImage),
      queue: Array.isArray(json?.queue) ? json.queue.slice(0, 20).map((t) => mapTrack(t, registerImage)).filter(Boolean) : [],
    };
  }

  async function transfer({ deviceId, play: startPlaying }) {
    await api("PUT", "/me/player", { body: { device_ids: [deviceId], ...(startPlaying === undefined ? {} : { play: startPlaying }) }, player: true });
    playbackCache = null;
    return { ok: true };
  }

  async function like({ trackId, liked: on }) {
    // February 2026: PUT/DELETE /me/library with URIs replace /me/tracks.
    await api(on ? "PUT" : "DELETE", "/me/library", { query: { uris: `spotify:track:${trackId}` } });
    for (const key of pageCache.keys()) if (key.startsWith("liked:")) pageCache.delete(key);
    return { trackId, liked: on };
  }

  async function isLiked(trackId) {
    const { json } = await api("GET", "/me/library/contains", { query: { uris: `spotify:track:${trackId}` } });
    return { trackId, liked: Array.isArray(json) && json[0] === true };
  }

  /** GET /api/spotify/status: the account plus current playback when connected. */
  async function phoneStatus() {
    await init();
    let current = null;
    if (connected()) {
      if (!profile && now() - profileAt > PROFILE_RETRY_MS) await refreshProfile().catch(() => {});
      current = connected() ? await playback().catch(() => null) : null;
    }
    const { available, ...account } = feature();
    return { configured: available, connected: false, premium: null, name: null, error, ...account, playback: current };
  }

  return {
    init,
    feature,
    status,
    phoneStatus,
    setClientId,
    disconnect,
    beginConnect,
    completeConnect,
    get configured() { return Boolean(clientId); },
    get connected() { return connected(); },
    get error() { return error; },
    imageKeyFor,
    image,
    playlists,
    liked,
    search,
    devices,
    playback,
    play,
    queue,
    upNext,
    transfer,
    like,
    isLiked,
    /** Test seams. */
    _pendingCount: () => pending.size,
    _tokens: () => tokens,
  };
}

function validTokens(value) {
  return Boolean(value)
    && typeof value.accessToken === "string" && value.accessToken
    && typeof value.refreshToken === "string" && value.refreshToken
    && Number.isFinite(value.expiresAt)
    && typeof value.clientId === "string";
}
