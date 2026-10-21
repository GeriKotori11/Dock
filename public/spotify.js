/**
 * Spotify account (Phase B): the pure rules and markup behind the Media
 * sheet's tabs, the connect flow and the playlist tiles
 * (docs/design/DOCK-CONTROLS.md sections 6.4, 12 and 13).
 *
 * No DOM and no browser globals, like dock.js and dock-controls.js: the PWA
 * gate renders every state here under Node. app.js wires it to the page.
 *
 * Images are host keys, never internet URLs: every cover goes through
 * /api/spotify/image, which the host proxies.
 */

import { icon } from "./icons.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- copy (section 13, Spotify Phase B) ----

export const SP_COPY = Object.freeze({
  entry: "Your playlists, search and devices",
  connect: "Connect Spotify",
  finishTitle: (computer) => `Finish on ${computer}`,
  finishBody: (computer) => `A browser window opened on ${computer}. Log in to Spotify there and allow WinDock. Your password never passes through this phone.`,
  waiting: "Waiting for Spotify…",
  reopen: "Open the window again",
  cancel: "Cancel",
  after: "After this: playlists, liked songs, search, the queue and choosing which device plays. Playing from your library needs Spotify Premium.",
  liked: "Liked Songs",
  likedCount: (n) => `${formatCount(n)} ${n === 1 ? "song" : "songs"}`,
  playing: "Playing",
  devicesLabel: "Play on",
  thisComputer: "This computer",
  devicesNote: "Only devices with Spotify open show up. Switching needs Spotify Premium.",
  premium: "Needs Spotify Premium",
  searchPlaceholder: "Songs, artists, albums",
  searchEmpty: (q) => `No results for "${q}".`,
  disconnected: "Spotify disconnected",
  connectAgain: "Connect again",
  disconnect: "Disconnect Spotify",
  busy: "Spotify is busy, try again in a moment",
  queued: "Added to queue",
  alreadyOnDock: "Already on your dock",
  playingName: (name) => `Playing ${name}`,
  connectFirst: (computer) => `Connect Spotify on ${computer} to play this`,
});

/** The tabs, in order (sp.tabs). */
export const SP_TABS = Object.freeze([
  { id: "now", label: "Now playing" },
  { id: "library", label: "Library" },
  { id: "search", label: "Search" },
  { id: "devices", label: "Devices" },
]);

/**
 * The Liked Songs row's key. The Web API has no Liked Songs context to play,
 * so the row starts the newest liked song (`uri` in `playBody`).
 */
export const LIKED_CONTEXT = "spotify:collection";
export const SEARCH_DEBOUNCE_MS = 300;
export const PAGE_SIZE = 30;
export const LONG_PRESS_MS = 500;
export const WAIT_STOP_MS = 60_000;
export const MAX_TILES = 64;

/** 1284 → "1,284". */
export function formatCount(n) {
  const value = Math.max(0, Math.round(Number(n) || 0));
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---- capability and visibility (6.4) ----

/**
 * `features.spotify.account`, or null when the host has no Spotify client
 * (missing, or `available` false): then every Phase B surface is hidden.
 * Premium is only "no" when the host says so.
 */
export function spotifyAccount(features) {
  const account = features?.spotify?.account;
  if (!isObject(account) || account.available !== true) return null;
  const connected = account.connected === true;
  return { available: true, connected, premium: !(connected && account.premium === false), name: text(account.name) };
}

/** Spotify is installed on the computer (Phase A's capability map). */
export function spotifyInstalled(features) {
  if (features?.spotify?.installed === true) return true;
  return list(features?.media?.players).some((player) => isObject(player) && player.id === "spotify" && player.installed === true);
}

/** The current media source is Spotify. */
export function isSpotifySource(media) {
  if (!media?.active || !media.source) return false;
  const { id, name, appId } = media.source;
  return id === "spotify" || /^spotify$/i.test(name || "") || /spotify/i.test(appId || "");
}

/**
 * Which Spotify surface the Media sheet shows: "hidden", "entry" (the footer
 * row: connect, or connect again after a revoked token), "waiting" (finish
 * login on the computer) or "tabs" (account connected).
 */
export function spotifyMode({ account, media = null, installed = false, disconnected = false, waiting = false } = {}) {
  if (!account) return "hidden";
  if (account.connected && !disconnected) return "tabs";
  if (waiting) return "waiting";
  if (disconnected || isSpotifySource(media) || installed) return "entry";
  return "hidden";
}

/** A known tab id, else "now". */
export function spotifyTab(id) {
  return SP_TABS.some((tab) => tab.id === id) ? id : "now";
}

/** The tab an arrow key, Home or End moves to (automatic activation). */
export function nextTab(current, key) {
  const ids = SP_TABS.map((tab) => tab.id);
  const at = Math.max(0, ids.indexOf(current));
  if (key === "Home") return ids[0];
  if (key === "End") return ids.at(-1);
  if (key === "ArrowRight") return ids[(at + 1) % ids.length];
  if (key === "ArrowLeft") return ids[(at - 1 + ids.length) % ids.length];
  return null;
}

// ---- data from the host ----

/** The cover route for a host image key; null for anything that looks like a URL. */
export function spotifyImageUrl(key) {
  const value = text(key);
  if (!value || value.length > 512 || /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[/\\]/.test(value) || /[\s\\]/.test(value)) return null;
  return `/api/spotify/image?key=${encodeURIComponent(value)}`;
}

const SPOTIFY_URI = /^spotify:(track|album|artist|playlist|episode|show):[A-Za-z0-9]{1,64}$/;
const TILE_URI = /^spotify:(playlist|album):[A-Za-z0-9]{1,64}$/;

/** A playable Spotify URI (or the Liked Songs context). */
export function isSpotifyUri(uri) {
  return uri === LIKED_CONTEXT || SPOTIFY_URI.test(String(uri || ""));
}

/** Only playlists and albums can become dock tiles. */
export function isTileUri(uri) {
  return TILE_URI.test(String(uri || ""));
}

function names(value) {
  if (typeof value === "string") return text(value);
  return list(value).map((entry) => (typeof entry === "string" ? text(entry) : text(entry?.name))).filter(Boolean).join(", ");
}

function normalizeItem(raw, kind) {
  if (!isObject(raw)) return null;
  const uri = text(raw.uri) || (text(raw.id) ? `spotify:${kind}:${text(raw.id)}` : "");
  if (!SPOTIFY_URI.test(uri) || !text(raw.name)) return null;
  const owner = isObject(raw.owner) ? text(raw.owner.name) || text(raw.owner.display_name) : text(raw.owner);
  const tracks = isObject(raw.tracks) ? raw.tracks.total : raw.tracks;
  return {
    kind,
    id: text(raw.id) || uri.split(":").pop(),
    uri,
    name: text(raw.name),
    image: text(raw.image) || null,
    owner: owner || "",
    tracks: Number.isFinite(tracks) && tracks >= 0 ? tracks : null,
    artists: names(raw.artists),
    album: isObject(raw.album) ? text(raw.album.name) : text(raw.album),
    durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : null,
  };
}

/** A playlists or liked page: `{ items, next }` where next is an offset, null at the end. */
export function normalizePage(raw, kind, offset = 0) {
  const items = list(raw?.items).map((item) => normalizeItem(item, kind)).filter(Boolean);
  let next = null;
  if (Number.isInteger(raw?.next) && raw.next > offset) next = raw.next;
  else if (raw?.next) next = offset + list(raw?.items).length;
  const total = Number.isInteger(raw?.total) && raw.total >= 0 ? raw.total : null;
  return { items, next, total };
}

/** Append a page to a paged list, dropping duplicates (a list that moved between pages). */
export function mergePage(current, page) {
  const seen = new Set(list(current?.items).map((item) => item.uri));
  const items = [...list(current?.items), ...page.items.filter((item) => !seen.has(item.uri) && seen.add(item.uri))];
  return { items, next: page.next, loading: false, error: null, loaded: true };
}

/** Search results by section. */
export function normalizeSearch(raw) {
  const pick = (value, kind) => list(isObject(value) ? value.items : value).map((item) => normalizeItem(item, kind)).filter(Boolean);
  return {
    tracks: pick(raw?.tracks, "track"),
    artists: pick(raw?.artists, "artist"),
    albums: pick(raw?.albums, "album"),
    playlists: pick(raw?.playlists, "playlist"),
  };
}

/** The Up next list (`{ currentlyPlaying, queue }`); anything malformed is dropped. */
export function normalizeQueue(raw) {
  return list(raw?.queue ?? raw?.items).map((item) => normalizeItem(item, "track")).filter(Boolean);
}

/** True when a playing context is the account's Liked Songs (`spotify:user:<id>:collection`). */
export function isLikedContext(uri) {
  return uri === LIKED_CONTEXT || /^spotify:user:[^:]+:collection$/.test(String(uri || ""));
}

/**
 * Spotify Connect devices. A device without an id, or a restricted one,
 * is listed but can't take playback.
 */
export function normalizeDevices(raw) {
  return list(raw?.devices).filter((d) => isObject(d) && text(d.name)).map((d) => ({
    id: text(d.id) || null,
    name: text(d.name),
    type: text(d.type) || "Unknown",
    active: d.active === true || d.is_active === true,
    restricted: d.restricted === true || !text(d.id),
    volume: Number.isFinite(d.volume) ? d.volume : null,
  }));
}

export function activeDevice(devices) {
  return list(devices).find((device) => device.active) || null;
}

/** The glyph for a device type. */
export function deviceIcon(type) {
  const value = String(type || "").toLowerCase();
  if (value === "smartphone" || value === "phone" || value === "tablet") return "phone";
  if (value === "computer") return "monitor";
  if (value === "tv" || value === "castvideo") return "monitor";
  return "speaker";
}

const TYPE_LABEL = { computer: "Computer", smartphone: "Phone", phone: "Phone", tablet: "Tablet", speaker: "Speaker", tv: "TV", avr: "Receiver", stb: "TV box", audiodongle: "Speaker", gameconsole: "Game console", castvideo: "Chromecast", castaudio: "Speaker", automobile: "Car" };

/** True when this Connect device is the computer WinDock runs on. */
export function isThisComputer(device, hostName) {
  return Boolean(device && hostName) && String(device.type).toLowerCase() === "computer" && device.name.toLowerCase() === String(hostName).toLowerCase();
}

/** "This computer · Playing", "Speaker", "Phone" (frame 22). */
export function deviceSubtitle(device, { hostName = "", playing = false } = {}) {
  const base = isThisComputer(device, hostName) ? SP_COPY.thisComputer : TYPE_LABEL[String(device?.type || "").toLowerCase()] || "Device";
  return device?.active && playing ? `${base} · ${SP_COPY.playing}` : base;
}

/**
 * What /api/spotify/status says about playback, from the shapes a Web API
 * proxy is likely to send. Everything is optional: the heart hides without a
 * track id, the "Playing" row without a context.
 */
export function normalizeSpotifyStatus(raw) {
  const value = isObject(raw) ? raw : {};
  const playback = isObject(value.playback) ? value.playback : value;
  const item = [playback.item, playback.track, value.track, value.item].find(isObject) || null;
  const trackId = text(item?.id) || (text(item?.uri).startsWith("spotify:track:") ? text(item.uri).split(":").pop() : "");
  const likedRaw = [playback.liked, item?.liked, value.liked].find((v) => typeof v === "boolean");
  const context = [playback.context?.uri, playback.contextUri, value.contextUri, value.context?.uri].map(text).find(Boolean) || null;
  const device = [playback.device, value.device].find(isObject);
  return {
    track: trackId ? { id: trackId, uri: text(item.uri) || `spotify:track:${trackId}`, name: text(item.name), artists: names(item.artists), image: text(item.image) || null } : null,
    liked: typeof likedRaw === "boolean" ? likedRaw : null,
    contextUri: context,
    playing: typeof playback.isPlaying === "boolean" ? playback.isPlaying : typeof playback.is_playing === "boolean" ? playback.is_playing : typeof playback.playing === "boolean" ? playback.playing : null,
    device: device && text(device.name) ? { id: text(device.id) || null, name: text(device.name), type: text(device.type) || "Unknown", active: true, volume: null } : null,
  };
}

/**
 * What a tap plays: a song by `uri`, a playlist, album or artist as a
 * context. Liked Songs has no context in the Web API: it starts the newest
 * liked song (`item.firstUri`), or nothing until that is known.
 */
export function playBody(item) {
  if (!item) return null;
  if (item.kind === "track") return isSpotifyUri(item.uri) ? { uri: item.uri } : null;
  if (item.kind === "liked") return isSpotifyUri(item.firstUri) && item.firstUri.startsWith("spotify:track:") ? { uri: item.firstUri } : null;
  return isSpotifyUri(item.uri) ? { contextUri: item.uri } : null;
}

/** The dock tile for a playlist or album, or null for anything else. */
export function spotifyTile(item) {
  if (!item || !isTileUri(item.uri) || !text(item.name)) return null;
  const tile = { kind: "spotify", uri: item.uri, label: text(item.name) };
  if (text(item.image)) tile.image = text(item.image);
  return tile;
}

/**
 * Toast copy and the follow-up for a failed Spotify call. `kind` is
 * "premium", "device", "busy", "disconnected" or "error".
 */
export function spotifyError(error, computer = "your computer") {
  const status = error?.status;
  // The host's JSON `error` string decides; the same status can mean different things (409).
  const detail = String(error?.detail || "").toLowerCase();
  if (detail === "spotify disconnected") return { kind: "disconnected", message: `${SP_COPY.disconnected} · ${SP_COPY.connectAgain}` };
  if (detail === "spotify not connected") return { kind: "not-connected", message: `Connect Spotify on ${computer} first.` };
  if (detail === "premium required") return { kind: "premium", message: SP_COPY.premium };
  if (detail === "rate limited" || status === 429) return { kind: "busy", message: SP_COPY.busy };
  if (detail === "no active device") return { kind: "device", message: "Spotify isn't open on any device. Open it, or pick a device in Devices." };
  if (detail === "spotify user not allowed") return { kind: "error", message: `This Spotify account isn't on the user list of the Spotify app WinDock uses. Check the WinDock page on ${computer}.` };
  if (detail === "spotify unavailable") return { kind: "error", message: "Spotify can't be reached right now. Try again in a moment." };
  if (detail === "spotify not configured") return { kind: "error", message: `Spotify isn't set up on ${computer}.` };
  if (error?.message === "Failed to fetch") return { kind: "error", message: "Connection lost. Check that WinDock is running on your computer." };
  return { kind: "error", message: error?.message || "Spotify couldn't do that. Try again." };
}

/**
 * Search as you type: 300 ms after the last keystroke, one request; a newer
 * query aborts the request in flight, and an answer for an older query is
 * never shown. `load(query, signal)` resolves to raw results;
 * `onState({ query, results, loading, error })` paints.
 */
export function createSearch({ load, onState, debounceMs = SEARCH_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout, Controller = globalThis.AbortController } = {}) {
  let timer = null, controller = null, seq = 0, query = "";
  function abort() { if (controller) { controller.abort(); controller = null; } }
  async function run(q, mine) {
    abort();
    const ctl = Controller ? new Controller() : null;
    controller = ctl;
    try {
      const raw = await load(q, ctl?.signal);
      if (mine !== seq) return;
      onState({ query: q, results: normalizeSearch(raw), loading: false, error: null });
    } catch (error) {
      if (mine !== seq || error?.name === "AbortError") return;
      onState({ query: q, results: null, loading: false, error });
    } finally {
      if (controller === ctl) controller = null;
    }
  }
  return {
    input(value) {
      query = String(value ?? "").trim();
      const mine = ++seq;
      if (timer !== null) clearTimer(timer);
      timer = null;
      abort();
      if (!query) return onState({ query: "", results: null, loading: false, error: null });
      // No `results` key: the caller keeps the previous answer on screen until the new one lands.
      onState({ query, loading: true, error: null });
      const q = query;
      timer = setTimer(() => { timer = null; run(q, mine); }, debounceMs);
    },
    /** Search now (Enter / the keyboard's search key). */
    flush() {
      if (timer === null || !query) return;
      clearTimer(timer); timer = null;
      run(query, seq);
    },
    cancel() { seq++; if (timer !== null) clearTimer(timer); timer = null; abort(); },
    get query() { return query; },
    get pending() { return timer !== null || controller !== null; },
  };
}

// ---- markup ----

/** The Spotify mark (the only place Spotify green appears, section 5.4). */
export function spotifyMark(className = "") {
  return `<svg class="sp-mark${className ? " " + className : ""}" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1ed760"/><path d="M6.2 9.4c3.7-1.1 8.1-.8 11.4 1.1M6.9 12.6c3.1-.9 6.5-.6 9.2.9M7.6 15.6c2.5-.7 5-.5 7.1.7" fill="none" stroke="#121212" stroke-width="1.75" stroke-linecap="round"/></svg>`;
}

/** The mark on its dark chip (source button, entry row, tile badge). */
export function spotifyChip(className = "") {
  return `<span class="sp-chip${className ? " " + className : ""}" aria-hidden="true">${spotifyMark()}</span>`;
}

/** The header's source button content when Spotify itself is the subject. */
export function spotifyBrand() {
  return `<span class="media-source__chip sp-chip">${spotifyMark()}</span><span class="media-source__name">Spotify</span>`;
}

function art(image, { round = false } = {}) {
  const url = spotifyImageUrl(image);
  return `<span class="sp-art${round ? " sp-art--round" : ""}" aria-hidden="true"><span class="media-glyph">${icon("music")}</span>${url ? `<img class="art-img" src="${esc(url)}" alt="" loading="lazy" decoding="async">` : ""}</span>`;
}

/** The tablist for the sheet header (frames 21, 22). */
export function renderSpTabs({ tab = "now", online = true } = {}) {
  const current = spotifyTab(tab);
  return [
    '<div class="sp-tabs" role="tablist" aria-label="Spotify">',
    ...SP_TABS.map(({ id, label }) => {
      const on = id === current;
      return `<button class="sp-tab${on ? " is-active" : ""}" type="button" role="tab" id="sp-tab-${id}" data-sp-tab="${id}" aria-selected="${on}" aria-controls="sp-tabpanel" tabindex="${on ? 0 : -1}"${online ? "" : " disabled"}>${label}</button>`;
    }),
    "</div>",
  ].join("");
}

/** The footer row of the Phase A sheet: connect, or connect again (12, 13). */
export function renderSpEntry({ disconnected = false, online = true } = {}) {
  return [
    `<div class="sp-entry${disconnected ? " is-disconnected" : ""}" role="group" aria-label="Spotify account">`,
    spotifyChip(),
    `<span class="sp-entry__text">${esc(disconnected ? SP_COPY.disconnected : SP_COPY.entry)}</span>`,
    `<button class="media-link" type="button" data-sp-connect${online ? "" : " disabled"}>${esc(disconnected ? SP_COPY.connectAgain : SP_COPY.connect)}</button>`,
    "</div>",
  ].join("");
}

/** Finish on the computer (frame 20). The spinner stops after 60 s; the words stay. */
export function renderSpWaiting({ computer = "your computer", stopped = false, online = true } = {}) {
  const off = online ? "" : " disabled";
  return [
    '<div class="media-empty sp-waiting">',
    `<span class="media-empty__glyph sp-waiting__glyph" aria-hidden="true">${spotifyMark()}</span>`,
    "<div>",
    `<h3>${esc(SP_COPY.finishTitle(computer))}</h3>`,
    `<p>${esc(SP_COPY.finishBody(computer))}</p>`,
    `<p class="sp-waiting__status" role="status"><span class="spinner${stopped ? " is-stopped" : ""}" aria-hidden="true"></span>${esc(SP_COPY.waiting)}</p>`,
    '<div class="media-actions">',
    `<button class="button" type="button" data-sp-reopen${off}>${esc(SP_COPY.reopen)}</button>`,
    `<button class="button" type="button" data-sp-cancel>${esc(SP_COPY.cancel)}</button>`,
    "</div></div></div>",
    `<p class="sp-note sp-after">${esc(SP_COPY.after)}</p>`,
  ].join("");
}

function itemSubtitle(item) {
  switch (item.kind) {
    case "playlist": return ["Playlist", item.owner, item.tracks !== null ? SP_COPY.likedCount(item.tracks) : ""].filter(Boolean).join(" · ");
    case "album": return ["Album", item.artists].filter(Boolean).join(" · ");
    case "artist": return "Artist";
    case "track": return [item.artists, item.album].filter(Boolean).join(" · ");
    default: return "";
  }
}

/**
 * One row: the whole row plays it. `playing` swaps the play glyph for the
 * speaker and "Playing"; `locked` (not Premium) keeps it readable but
 * aria-disabled, without the play glyph.
 */
function renderRow(item, { playing = false, locked = false, online = true, compact = false, title, subtitle, artHtml } = {}) {
  const sub = subtitle ?? itemSubtitle(item);
  const tail = playing
    ? `<span class="sp-row__playing">${icon("volume")}${esc(SP_COPY.playing)}</span>`
    : locked ? "" : `<span class="sp-row__tail" aria-hidden="true">${icon("play", "icon--fill")}</span>`;
  const attrs = [
    `data-sp-uri="${esc(item.uri)}"`,
    `data-sp-kind="${esc(item.kind)}"`,
    `data-sp-name="${esc(item.name)}"`,
    item.image ? `data-sp-image="${esc(item.image)}"` : "",
    sub ? `data-sp-sub="${esc(sub)}"` : "",
    locked ? 'aria-disabled="true"' : "",
    playing ? 'aria-current="true"' : "",
    online ? "" : "disabled",
  ].filter(Boolean).join(" ");
  return [
    `<li><button class="sp-row${compact ? " sp-row--compact" : ""}${playing ? " is-playing" : ""}" type="button" ${attrs}>`,
    artHtml ?? art(item.image, { round: item.kind === "artist" }),
    `<span class="sp-row__text"><span class="sp-row__title">${esc(title ?? item.name)}</span>${sub ? `<span class="sp-row__sub">${esc(sub)}</span>` : ""}</span>`,
    tail,
    "</button></li>",
  ].join("");
}

function premiumNote(premium) {
  return premium ? "" : `<p class="sp-note sp-note--premium">${icon("lock")}${esc(SP_COPY.premium)}</p>`;
}

function statusLine({ loading, error, retry, loadingText }) {
  if (error) return `<p class="sp-status" role="status">${esc(error)} <button class="sp-retry" type="button" data-sp-retry="${esc(retry)}">Try again</button></p>`;
  if (loading) return `<p class="sp-status" role="status"><span class="spinner" aria-hidden="true"></span>${esc(loadingText)}</p>`;
  return "";
}

/**
 * Library (frame 21): Liked Songs first, then playlists, two columns,
 * rows 60, art 44. `playingUri` is the context playing now.
 */
export function renderSpLibrary({ likedTotal = null, playlists = null, playingUri = null, premium = true, online = true } = {}) {
  const state = playlists || { items: [], next: 0, loading: true, error: null, loaded: false };
  const locked = !premium;
  const liked = { kind: "liked", uri: LIKED_CONTEXT, name: SP_COPY.liked, image: null };
  const likedArt = `<span class="sp-art sp-art--liked" aria-hidden="true">${icon("heart", "icon--fill")}</span>`;
  return [
    '<div class="sp-panel" id="sp-tabpanel" role="tabpanel" aria-labelledby="sp-tab-library">',
    premiumNote(premium),
    '<ul class="sp-list" aria-label="Your library">',
    renderRow(liked, { playing: isLikedContext(playingUri), locked, online, subtitle: likedTotal !== null ? SP_COPY.likedCount(likedTotal) : "", artHtml: likedArt }),
    ...list(state.items).map((item) => renderRow(item, { playing: playingUri === item.uri, locked, online })),
    "</ul>",
    statusLine({ loading: state.loading, error: state.error, retry: "library", loadingText: state.loaded ? "Loading more…" : "Loading your library…" }),
    state.next !== null && !state.loading && !state.error && state.loaded ? '<span class="sp-more" data-sp-more aria-hidden="true"></span>' : "",
    "</div>",
  ].join("");
}

/** The Search tab's frame: the field stays put while results change under it. */
export function renderSpSearchPanel({ premium = true, online = true } = {}) {
  return [
    '<div class="sp-panel sp-panel--search" id="sp-tabpanel" role="tabpanel" aria-labelledby="sp-tab-search">',
    `<label class="search-box sp-search">${icon("search")}<input type="search" data-sp-search placeholder="${esc(SP_COPY.searchPlaceholder)}" aria-label="Search Spotify" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"${online ? "" : " disabled"}></label>`,
    premiumNote(premium),
    '<div class="sp-results" data-sp-results></div>',
    "</div>",
  ].join("");
}

/** Search results: Songs, Artists, Albums, Playlists (rows 56). */
export function renderSpResults({ query = "", results = null, loading = false, error = null, premium = true, online = true, playingUri = null } = {}) {
  if (!query) return "";
  if (error) return statusLine({ error, retry: "search" });
  if (!results) return loading ? statusLine({ loading: true, loadingText: "Searching…" }) : "";
  const sections = [["Songs", results.tracks], ["Artists", results.artists], ["Albums", results.albums], ["Playlists", results.playlists]].filter(([, items]) => items.length);
  if (!sections.length) return `<p class="sp-status" role="status">${esc(SP_COPY.searchEmpty(query))}</p>`;
  return sections.map(([label, items]) => [
    `<h3 class="sp-label">${label}</h3>`,
    `<ul class="sp-list sp-list--compact" aria-label="${label}">`,
    ...items.map((item) => renderRow(item, { playing: playingUri === item.uri, locked: !premium, online, compact: true })),
    "</ul>",
  ].join("")).join("");
}

/** Devices (frame 22): current one checked; tap = transfer. */
export function renderSpDevices({ devices = null, loading = false, error = null, premium = true, online = true, hostName = "", playing = false } = {}) {
  const items = list(devices);
  const rows = items.map((device) => {
    const attrs = [
      device.id ? `data-sp-device="${esc(device.id)}"` : "",
      device.active ? 'aria-current="true"' : "",
      (!premium || device.restricted) && !device.active ? 'aria-disabled="true"' : "",
      online ? "" : "disabled",
    ].filter(Boolean).join(" ");
    return [
      `<li><button class="sp-row sp-row--device${device.active ? " is-active" : ""}" type="button" ${attrs}>`,
      `<span class="sp-dev" aria-hidden="true">${icon(deviceIcon(device.type))}</span>`,
      `<span class="sp-row__text"><span class="sp-row__title">${esc(device.name)}</span><span class="sp-row__sub">${esc(deviceSubtitle(device, { hostName, playing }))}</span></span>`,
      device.active ? `<span class="sp-row__check" aria-hidden="true">${icon("check")}</span>` : "",
      "</button></li>",
    ].join("");
  });
  return [
    '<div class="sp-panel" id="sp-tabpanel" role="tabpanel" aria-labelledby="sp-tab-devices">',
    `<h3 class="sp-label" id="sp-devices-label">${esc(SP_COPY.devicesLabel)}</h3>`,
    premiumNote(premium),
    rows.length ? `<ul class="sp-list" aria-labelledby="sp-devices-label">${rows.join("")}</ul>` : "",
    statusLine({ loading: loading && !rows.length, error, retry: "devices", loadingText: "Looking for devices…" }),
    `<p class="sp-note">${esc(SP_COPY.devicesNote)}</p>`,
    `<button class="sp-disconnect" type="button" data-sp-disconnect>${esc(SP_COPY.disconnect)}</button>`,
    "</div>",
  ].join("");
}

/**
 * The footer on every tab: current track, Play/Pause and the device chip.
 * `track` is { title, artist, image?, artwork? }; `canPlay` says whether the
 * local transport can reach it.
 */
export function renderSpFooter({ track = null, playing = false, canPlay = false, device = null, online = true } = {}) {
  const url = track?.artwork || spotifyImageUrl(track?.image);
  const thumb = `<span class="sp-foot__art" aria-hidden="true"><span class="media-glyph">${icon("music")}</span>${url ? `<img class="art-img" src="${esc(url)}" alt="" decoding="async">` : ""}</span>`;
  const words = track?.title
    ? `<strong>${esc(track.title)}</strong>${track.artist ? ` · ${esc(track.artist)}` : ""}`
    : "Nothing playing";
  const play = `<button class="sp-foot__play" type="button" data-media="${playing ? "pause" : "play"}" aria-label="${playing ? "Pause" : "Play"}"${canPlay && online ? "" : " disabled"}>${icon(playing ? "pause" : "play", playing ? "" : "icon--fill")}</button>`;
  const chip = device
    ? `<button class="sp-foot__device" type="button" data-sp-goto="devices" aria-label="${esc(`Playing on ${device.name}. Choose a device.`)}"${online ? "" : " disabled"}>${icon(deviceIcon(device.type))}<span>${esc(device.name)}</span></button>`
    : "";
  return `<div class="sp-foot" role="group" aria-label="Spotify">${thumb}<span class="sp-foot__text">${words}</span>${play}${chip}</div>`;
}

/** Up next (Now playing, wide screens): at most five. */
export function renderSpUpNext(items) {
  const next = list(items).slice(0, 5);
  if (!next.length) return "";
  return [
    '<aside class="sp-upnext" aria-label="Up next">',
    '<h3 class="sp-label">Up next</h3>',
    '<ol class="sp-upnext__list">',
    ...next.map((item) => `<li>${art(item.image)}<span class="sp-row__text"><span class="sp-row__title">${esc(item.name)}</span>${item.artists ? `<span class="sp-row__sub">${esc(item.artists)}</span>` : ""}</span></li>`),
    "</ol></aside>",
  ].join("");
}

/** The heart next to the title (Now playing). */
export function renderLikeButton({ liked = false, online = true, busy = false } = {}) {
  return `<button class="media-like" type="button" data-sp-like aria-label="Like" aria-pressed="${liked ? "true" : "false"}"${busy ? ' aria-busy="true"' : ""}${online ? "" : " disabled"}>${icon("heart", liked ? "icon--fill" : "")}</button>`;
}

/**
 * The long-press menu's actions: Play, Add to dock (playlists and albums),
 * Add to queue (songs). `locked` disables Play and queue (not Premium).
 */
export function spotifyMenuActions(item, { premium = true } = {}) {
  if (!item) return [];
  const actions = [{ id: "play", label: "Play", icon: "play", disabled: !premium }];
  if (item.kind === "track") actions.push({ id: "queue", label: "Add to queue", icon: "plus", disabled: !premium });
  if (isTileUri(item.uri)) actions.push({ id: "dock", label: "Add to dock", icon: "grid", disabled: false });
  return actions;
}

export function renderSpMenuActions(item, options) {
  return spotifyMenuActions(item, options).map((action) =>
    `<button type="button" data-sp-menu="${action.id}"${action.disabled ? " disabled" : ""}>${icon(action.icon, action.id === "play" ? "icon--fill" : "")}${esc(action.label)}</button>`).join("");
}

/** Cover art for a menu, tile or options sheet. */
export function spotifyCover(image, fallback = "?") {
  const url = spotifyImageUrl(image);
  return `<span class="app-icon sp-cover${url ? "" : " icon-failed"}"><span class="app-icon__fallback">${esc(String(fallback).trim().slice(0, 1).toUpperCase() || "?")}</span>${url ? `<img src="${esc(url)}" alt="" decoding="async">` : ""}</span>`;
}

/** A pinned playlist or album tile's glyph: the cover with a small Spotify badge. */
export function spotifyTileGlyph(tile) {
  return `${spotifyCover(tile?.image, tile?.label)}<span class="sp-badge">${spotifyMark()}</span>`;
}
