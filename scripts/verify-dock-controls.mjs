/**
 * Dock controls oracle (docs/design/DOCK-CONTROLS.md, host side): the
 * capability map, the running poll, close by app, media + artwork, volume,
 * permissions, deferred power, and the macOS/Windows provider argv. Runs on
 * any OS: every native call goes through a recording fake exec, and time is
 * driven through injected timers.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createChecker } from "./lib/assert.mjs";
import { createApp } from "../server.js";
import { createConfigStore } from "../src/config.js";
import {
  featuresOf,
  DESTRUCTIVE_VERBS,
  isDestructiveVerb,
  validateMediaCommand,
  validateVolume,
  normalizeMediaState,
  nowPlayingFromMedia,
  validArtworkKey,
  mediaArtworkPath,
  CONTROL_VERBS,
} from "../src/platform/contract.js";
import { imageInfo, spotifyArtworkUrl, artworkKey, fetchSpotifyArtwork } from "../src/platform/artwork.js";
import { createWindowsProvider, windowsClosable, findSpotify, parseMediaState } from "../src/platform/windows.js";
import { createLinuxProvider } from "../src/platform/linux.js";
import {
  createMacProvider,
  macClosable,
  parseVolume,
  permissionFromCode,
  osascriptArgv,
  appleScriptArgv,
  RUNNING_JXA,
  PERMISSION_JXA,
  SPOTIFY_STATE_JXA,
  SPOTIFY_COMMAND_JXA,
  MUSIC_STATE_JXA,
  MUSIC_COMMAND_JXA,
  MUSIC_ARTWORK_AS,
  VOLUME_GET_AS,
  VOLUME_SET_AS,
  POWER_AS,
  LOCK_JXA,
  SESSION_JXA,
  OSASCRIPT,
  OPEN,
  PMSET,
  SIPS,
  AUTOMATION_SETTINGS_URL,
  MAC_CONTROL_VERBS,
} from "../src/platform/macos.js";

const t = createChecker("dock-controls");
const dir = await mkdtemp(join(tmpdir(), "windock-dock-controls-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(5);
  }
}

/** PNG bytes with the given IHDR size (enough for imageInfo). */
function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
/** Minimal JPEG: SOI, an APP0 segment, then SOF0 with the size. */
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(12)]);
}

function fakeTimers() {
  const pending = new Map();
  let next = 0;
  return {
    pending,
    setTimeout(fn, ms) {
      const handle = { id: ++next, fn, ms, unref() {} };
      pending.set(handle.id, handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) pending.delete(handle.id);
    },
    count(ms) {
      return [...pending.values()].filter((h) => h.ms === ms).length;
    },
    fire(ms) {
      const due = [...pending.values()].filter((h) => h.ms === ms);
      for (const h of due) {
        pending.delete(h.id);
        h.fn();
      }
      return due.length;
    },
  };
}

let fileNo = 0;
async function serve(provider, options = {}) {
  const app = await createApp({
    provider,
    configStore: createConfigStore({ path: join(dir, `config-${++fileNo}.json`) }),
    pin: "432100",
    trustLoopback: true,
    log: () => {},
    ...options,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const req = async (path, body, method = body ? "POST" : "GET", headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json", ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString("utf8")); } catch { /* binary */ }
    return { status: res.status, json, buf, headers: res.headers };
  };
  const sockets = [];
  async function dock() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages = [];
    ws.on("message", (m) => messages.push(JSON.parse(String(m))));
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await until(() => messages.length >= 1, "connect snapshot");
    sockets.push(ws);
    return { ws, messages };
  }
  async function stop() {
    for (const ws of sockets) ws.terminate();
    await app.hub.close();
    await new Promise((r) => app.server.close(r));
  }
  return { app, req, dock, stop, base };
}

/** A configurable fake provider with every dock-controls method. */
function fakeProvider(overrides = {}) {
  const calls = { control: [], close: [], media: 0, mediaCommand: [], artwork: [], volume: 0, setVolume: [], permission: [], settings: [], launch: [], running: 0, featureState: 0 };
  const p = {
    id: "fake",
    displayName: "Fake",
    calls,
    runningList: [],
    features: {
      close: true,
      media: { sources: "apps", artwork: true, sessions: false },
      volume: { get: true, set: true, mute: true },
      power: { lock: "ready", sleep: "ready", restart: "ready", shutdown: "ready" },
      spotify: { local: { nowPlaying: true, transport: true, artwork: true, seek: true, shuffle: true, repeat: true } },
    },
    async listInstalledApps() { return [{ id: "com.spotify.client", name: "Spotify", target: "/Applications/Spotify.app" }, { id: "app.notes", name: "Notes", target: "/A/Notes.app" }]; },
    async listRunningApps() { calls.running += 1; return p.runningList.map((r) => ({ ...r })); },
    async launchApp(app) { calls.launch.push(app.id); },
    async focusApp() {},
    async closeApp(entry) { calls.close.push(entry.pid); },
    async control(verb, value) { calls.control.push([verb, value]); },
    async nowPlaying() { return { title: "legacy", artist: "", playing: false }; },
    async systemStats() { return {}; },
    ...overrides,
  };
  return p;
}

// =========================================================================
// 1. contract: capability map, validators, normalization
// =========================================================================

t.deepEqual([...DESTRUCTIVE_VERBS], ["sleep", "shutdown", "restart"], "lock is no longer a destructive verb");
t.ok(!isDestructiveVerb("lock") && isDestructiveVerb("sleep"), "isDestructiveVerb follows the new set");

const legacy = featuresOf({});
t.deepEqual(Object.keys(legacy), ["controls", "nowPlaying", "capture", "input"], "a legacy provider gets only the four legacy keys");
const linux = featuresOf(createLinuxProvider({ exec: async () => ({ stdout: "" }) }));
t.deepEqual(Object.keys(linux), ["controls", "nowPlaying", "capture", "input"], "Linux omits every new key (7.2)");

const winProvider = createWindowsProvider({ exec: async () => ({ stdout: "" }), helperPath: "H.exe" });
const winFeatures = featuresOf(winProvider, await winProvider.featureState({
  installed: [{ id: "c:/users/me/appdata/roaming/spotify/spotify.exe", name: "Spotify" }],
  running: [{ id: "c:/users/me/appdata/roaming/spotify/spotify.exe", name: "Spotify", pid: 9 }],
}));
t.deepEqual(winFeatures, {
  controls: true, nowPlaying: true, capture: true, input: true,
  close: true,
  media: {
    sources: "system",
    players: [{ id: "spotify", name: "Spotify", appId: "c:/users/me/appdata/roaming/spotify/spotify.exe", installed: true, running: true, permission: "not-required" }],
    artwork: true,
    sessions: true,
  },
  volume: { get: true, set: true, mute: true },
  power: { lock: "ready", sleep: "ready", restart: "ready", shutdown: "ready" },
  spotify: {
    installed: true,
    local: { nowPlaying: true, transport: true, artwork: true, seek: false, shuffle: false, repeat: false },
    account: { available: false },
  },
}, "Windows capability map (7.2): system media, Spotify from the catalog, every power verb ready");
t.ok(Object.isFrozen(winFeatures) && Object.isFrozen(winFeatures.media.players[0]) && Object.isFrozen(winFeatures.power), "the capability map is deeply frozen");
const winNoSpotify = featuresOf(winProvider, await winProvider.featureState({ installed: [], running: [] }));
t.deepEqual(winNoSpotify.media.players, [], "no Spotify entry when it is not installed");
t.equal(winNoSpotify.spotify.installed, false, "spotify.installed false without the app");
t.ok(findSpotify([{ id: "shell:appsfolder/spotifyab.spotifymusic_zpdnekdrzrea0!spotify" }]), "the Store Spotify package is found");
t.equal(findSpotify([{ id: "c:/apps/notspotify.exe" }]), null, "a lookalike exe is not Spotify");

const odd = featuresOf({ features: {
  power: { lock: "ready", sleep: "maybe", restart: "denied" },
  media: { sources: "cloud" },
  volume: { get: false, set: false, mute: false },
} }, { players: [{ id: "x", permission: "weird" }], power: { restart: "nonsense" } });
t.deepEqual(odd.power, { lock: "ready" }, "unknown power statuses are dropped (not offered)");
t.ok(!("media" in odd), "an unknown media source is not offered");
t.ok(!("volume" in odd), "an all-false volume block is not offered");

t.ok(validateMediaCommand({ action: "seek", value: 72000 }).ok, "seek with integer ms is valid");
for (const bad of [{ action: "seek", value: 1.5 }, { action: "seek", value: -1 }, { action: "seek" }, { action: "shuffle", value: "yes" },
  { action: "repeat", value: "twice" }, { action: "play", value: 1 }, { action: "rm -rf" }, {}, { action: "open", value: "../x" },
  { action: "select" }, { action: "next", sessionId: "a b" }]) {
  t.ok(!validateMediaCommand(bad).ok, `media command rejected: ${JSON.stringify(bad)}`);
}
t.deepEqual(validateMediaCommand({ action: "select", sessionId: "s1" }), { ok: true, action: "select", value: "s1", sessionId: "s1" }, "select takes the sessionId");
t.deepEqual(validateVolume({ level: 45 }), { ok: true, level: 45 }, "volume level validates");
for (const bad of [{}, { level: 101 }, { level: 4.5 }, { level: "40" }, { muted: "true" }]) {
  t.ok(!validateVolume(bad).ok, `volume body rejected: ${JSON.stringify(bad)}`);
}

const key = artworkKey("spotify", "https://i.scdn.co/image/abc");
t.ok(validArtworkKey(key), "artworkKey mints a valid key");
for (const bad of ["", "ABCDEF0123456789ABCDEF0123456789", "../../etc/passwd", key.slice(0, 31), `${key}0`, null]) {
  t.ok(!validArtworkKey(bad), `artwork key rejected: ${JSON.stringify(bad)}`);
}
t.equal(mediaArtworkPath(key), `/api/media/artwork?key=${key}`, "artwork path format");
const normalized = normalizeMediaState({
  source: { id: "spotify", name: "Spotify", appId: "com.spotify.client" },
  title: "Houdini", artist: "Dua Lipa", playing: true, positionMs: 999999, durationMs: 185000,
  artwork: "https://i.scdn.co/image/abc", repeat: "sometimes", shuffle: "yes", controls: { next: true, seek: "y" },
}, 5);
t.equal(normalized.artwork, null, "an internet artwork URL never reaches the phone");
t.equal(normalized.positionMs, 185000, "position is clamped to the duration");
t.equal(normalized.repeat, null, "an unknown repeat mode becomes null");
t.equal(normalized.shuffle, null, "a non-boolean shuffle becomes null");
t.deepEqual(normalized.controls, { previous: false, next: true, playPause: false, seek: false, shuffle: false, repeat: false }, "controls are strict booleans");
t.deepEqual(Object.keys(normalizeMediaState(null)), ["source", "title", "artist", "album", "playing", "positionMs", "durationMs", "updatedAt", "artwork", "controls", "shuffle", "repeat", "sessions", "permission"], "the empty state has the 8.3 keys");
t.deepEqual(nowPlayingFromMedia(normalized), { title: "Houdini", artist: "Dua Lipa", playing: true }, "legacy now playing derives from media");
t.equal(nowPlayingFromMedia(normalizeMediaState(null)), null, "nothing playing derives to null");

t.deepEqual(imageInfo(png(640, 480)), { mime: "image/png", width: 640, height: 480 }, "imageInfo reads PNG sizes");
t.deepEqual(imageInfo(jpeg(300, 200)), { mime: "image/jpeg", width: 300, height: 200 }, "imageInfo reads JPEG sizes");
t.equal(imageInfo(Buffer.from("<svg>not an image at all</svg>")), null, "imageInfo rejects other bytes");
t.equal(spotifyArtworkUrl("https://i.scdn.co/image/ab67"), "https://i.scdn.co/image/ab67", "the Spotify artwork host is allowed");
for (const bad of ["http://i.scdn.co/image/x", "https://evil.example/i.scdn.co", "https://i.scdn.co.evil.example/x", "https://user:pw@i.scdn.co/x", "https://i.scdn.co:444/x", "file:///etc/passwd", 42]) {
  t.equal(spotifyArtworkUrl(bad), null, `artwork URL refused: ${String(bad)}`);
}
{
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([url, init.redirect]); return { ok: true, headers: { get: () => null }, arrayBuffer: async () => jpeg(640, 640) }; };
  t.ok(await fetchSpotifyArtwork("https://i.scdn.co/image/a", { fetchImpl }), "allowlisted artwork is fetched");
  t.equal(await fetchSpotifyArtwork("https://evil.example/a", { fetchImpl }), null, "a non-allowlisted URL is never fetched");
  t.deepEqual(seen, [["https://i.scdn.co/image/a", "error"]], "exactly one fetch, with redirects refused");
}

// =========================================================================
// 2. running poll: start/stop with docks, single-flight, diff, closable
// =========================================================================
{
  const timers = fakeTimers();
  const p = fakeProvider({ sessionState: async () => ({ locked: false }) });
  p.runningList = [{ id: "app.notes", name: "Notes", title: "", pid: 10 }, { id: "com.apple.finder", name: "Finder", pid: 11, closable: false }];
  const h = await serve(p, { timers, runningPollMs: 3000 });
  t.equal(h.app.polling, false, "no poll before any dock connects");
  t.equal(timers.count(3000), 0, "no poll timer without docks");
  const d1 = await h.dock();
  t.equal(h.app.polling, true, "the poll starts with the first dock");
  t.equal(timers.count(3000), 1, "exactly one poll timer is pending");
  const snap = d1.messages[0];
  t.deepEqual(snap.session, { locked: false }, "the snapshot carries session.locked");
  t.equal(snap.running.find((r) => r.pid === 10).closable, true, "a regular app is closable");
  t.equal(snap.running.find((r) => r.pid === 11).closable, false, "an app the provider marks unclosable stays unclosable");
  t.ok(snap.features.close === true && snap.features.power.lock === "ready", "the snapshot carries the capability map");

  // No change: no broadcast.
  timers.fire(3000);
  await until(() => timers.count(3000) === 1, "poll rescheduled");
  await sleep(30);
  t.equal(d1.messages.length, 1, "an unchanged running list broadcasts nothing");

  // A title change is not a change (diff by id, pid).
  p.runningList[0].title = "New title";
  timers.fire(3000);
  await until(() => timers.count(3000) === 1, "poll rescheduled after title change");
  await sleep(30);
  t.equal(d1.messages.length, 1, "a window-title change alone broadcasts nothing");

  // An app quit on the computer: broadcast.
  p.runningList = p.runningList.filter((r) => r.pid !== 10);
  timers.fire(3000);
  await until(() => d1.messages.length === 2, "broadcast after the app quit");
  t.deepEqual(d1.messages[1].running.map((r) => r.pid), [11], "the broadcast drops the quit app");

  // Single flight: a slow tick schedules nothing until it finishes.
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowList = p.listRunningApps;
  p.listRunningApps = async () => { await gate; return slowList(); };
  timers.fire(3000);
  await sleep(20);
  t.equal(timers.count(3000), 0, "no next poll is scheduled while one is in flight");
  release();
  await until(() => timers.count(3000) === 1, "next poll after the slow one");
  p.listRunningApps = slowList;

  // Feature changes re-broadcast (e.g. permission granted, Spotify started).
  let restart = "needs-permission";
  p.featureState = async () => ({ power: { restart } });
  timers.fire(3000);
  await until(() => d1.messages.length === 3, "broadcast after features changed");
  t.equal(d1.messages[2].features.power.restart, "needs-permission", "the new power status is broadcast");
  restart = "ready";
  timers.fire(3000);
  await until(() => d1.messages.length === 4, "broadcast after permission granted");
  t.equal(d1.messages[3].features.power.restart, "ready", "a granted permission is re-broadcast");

  // session.locked changes re-broadcast.
  p.sessionState = async () => ({ locked: true });
  timers.fire(3000);
  await until(() => d1.messages.length === 5, "broadcast after lock");
  t.deepEqual(d1.messages[4].session, { locked: true }, "session.locked is re-broadcast");

  // Stop when the last dock leaves.
  d1.ws.close();
  await until(() => h.app.polling === false, "poll stops without docks");
  t.equal(timers.count(3000), 0, "the pending poll timer is cleared");
  await h.stop();
}

// Our own process is never closable.
{
  const p = fakeProvider();
  p.runningList = [{ id: "node", name: "node", pid: process.pid }];
  const h = await serve(p);
  const state = await h.req("/api/state");
  t.equal(state.json.running[0].closable, false, "the WinDock host's own process is not closable");
  t.ok(!("session" in state.json), "no session key when the provider cannot tell");
  await h.stop();
}
// Providers mark the 5.1 cases.
t.equal(windowsClosable({ name: "explorer", path: "C:\\Windows\\explorer.exe" }), false, "File Explorer / the shell is not closable");
t.equal(windowsClosable({ name: "WinDockTray", path: "C:\\Program Files\\WinDock\\WinDockTray.exe" }), false, "the tray is not closable");
t.equal(windowsClosable({ name: "ApplicationFrameHost", path: "" }), false, "shell hosts are not closable");
t.equal(windowsClosable({ name: "notepad", path: "C:\\Windows\\notepad.exe" }), true, "Notepad is closable");
t.equal(macClosable({ bundleId: "com.apple.finder" }), false, "Finder is not closable");
t.equal(macClosable({ bundleId: "dev.gerikotori.windock.menu" }), false, "the WinDock menu-bar app is not closable");
t.equal(macClosable({ bundleId: "com.apple.calculator" }), true, "Calculator is closable");

// =========================================================================
// 3. close by app id
// =========================================================================
{
  const p = fakeProvider();
  p.runningList = [
    { id: "app.notepad", name: "notepad", title: "a.txt", pid: 21 },
    { id: "app.notepad", name: "notepad", title: "b.txt", pid: 22 },
    { id: "app.notepad", name: "notepad", title: "c.txt", pid: 23 },
    { id: "app.shell", name: "explorer", title: "", pid: 30, closable: false },
  ];
  // pid 22 "asks to save": it never exits.
  p.closeApp = async (entry) => {
    p.calls.close.push(entry.pid);
    if (entry.pid !== 22) p.runningList = p.runningList.filter((r) => r.pid !== entry.pid);
  };
  const h = await serve(p, { closePollMs: 10, closeWaitMs: 60 });
  const d = await h.dock();
  const before = d.messages.length;
  const closed = await h.req("/api/apps/close", { id: "app.notepad" });
  t.equal(closed.status, 200, "close by id answers 200");
  t.deepEqual(closed.json, { ok: true, id: "app.notepad", requested: 3, closed: 2, stillOpen: [{ pid: 22, title: "b.txt" }] },
    "close by id reports requested, closed and what is still open");
  t.deepEqual(p.calls.close, [21, 22, 23], "every instance of the app was asked to close, once each");
  await until(() => d.messages.length > before, "broadcast after close");
  t.deepEqual(d.messages.at(-1).running.map((r) => r.pid), [22, 30], "the broadcast reflects what closed");

  t.equal((await h.req("/api/apps/close", { id: "app.gone" })).status, 404, "an app that is not running: 404");
  t.equal((await h.req("/api/apps/close", { id: "app.gone" })).json.error, "not running", "404 body names it");
  const shell = await h.req("/api/apps/close", { id: "app.shell" });
  t.equal(shell.status, 403, "an unclosable app: 403");
  t.equal(shell.json.error, "not closable", "403 body names it");
  t.ok(!p.calls.close.includes(30), "an unclosable app is never sent a close");
  t.equal((await h.req("/api/apps/close", { id: 42 })).status, 400, "a non-string id is refused");
  const byPid = await h.req("/api/apps/close", { pid: 22 });
  t.deepEqual([byPid.status, byPid.json], [200, { ok: true, pid: 22 }], "the { pid } form still works");
  await h.stop();

  const noClose = fakeProvider({ features: {} });
  noClose.runningList = [{ id: "x", pid: 5 }];
  const h2 = await serve(noClose);
  const unavailable = await h2.req("/api/apps/close", { id: "x" });
  t.deepEqual([unavailable.status, unavailable.json.error], [501, "close unavailable"], "a host without close: 501");
  t.equal((await h2.req("/api/state")).json.running[0].closable, false, "nothing is closable without the close feature");
  await h2.stop();
}

// =========================================================================
// 4. media routes, artwork, now playing
// =========================================================================
{
  const artKey = artworkKey("spotify", "https://i.scdn.co/image/1");
  let state = {
    source: { id: "spotify", name: "Spotify", appId: "com.spotify.client", sessionId: null },
    title: "Houdini", artist: "Dua Lipa", album: "Radical Optimism", playing: true,
    positionMs: 72000, durationMs: 185000, artwork: mediaArtworkPath(artKey),
    controls: { previous: true, next: true, playPause: true, seek: true, shuffle: true, repeat: true },
    shuffle: true, repeat: "off", sessions: [], permission: null,
  };
  let commandError = null;
  const p = fakeProvider({
    async media() { p.calls.media += 1; return state; },
    async mediaCommand(action, value, sessionId) {
      p.calls.mediaCommand.push([action, value, sessionId]);
      if (commandError) throw commandError;
      if (action === "pause") state = { ...state, playing: false };
    },
    async mediaArtwork(k) {
      p.calls.artwork.push(k);
      if (k === artKey) return { mime: "image/png", bytes: png(300, 300) };
      if (k === "0".repeat(32)) return { mime: "image/png", bytes: Buffer.from("<script>") };
      return null;
    },
    featureState: async ({ installed, running }) => ({
      players: [{ id: "spotify", name: "Spotify", appId: "com.spotify.client", installed: true, running: false, permission: "granted" }],
    }),
  });
  const h = await serve(p, { mediaCacheMs: 10_000 });
  await h.req("/api/state"); // live features
  const m1 = await h.req("/api/media");
  t.equal(m1.status, 200, "GET /api/media answers 200");
  t.equal(m1.json.title, "Houdini", "media carries the title");
  t.equal(m1.json.artwork, `/api/media/artwork?key=${artKey}`, "artwork is a host path");
  await h.req("/api/media");
  t.equal(p.calls.media, 1, "polling phones share one read (cache)");
  const np = await h.req("/api/nowplaying");
  t.deepEqual(np.json, { nowPlaying: { title: "Houdini", artist: "Dua Lipa", playing: true } }, "/api/nowplaying derives from media()");

  const paused = await h.req("/api/media", { action: "pause" });
  t.equal(paused.status, 200, "POST /api/media answers 200");
  t.equal(paused.json.playing, false, "POST returns the new (fresh) media state");
  t.deepEqual(p.calls.mediaCommand.at(-1), ["pause", null, null], "the provider gets the action");
  await h.req("/api/media", { action: "seek", value: 30000 });
  t.deepEqual(p.calls.mediaCommand.at(-1), ["seek", 30000, null], "seek passes ms");
  t.equal((await h.req("/api/media", { action: "seek", value: "30s" })).status, 400, "a bad seek value: 400");
  t.equal((await h.req("/api/media", { action: "explode" })).status, 400, "an unknown action: 400");
  const select = await h.req("/api/media", { action: "select", sessionId: "s1" });
  t.deepEqual([select.status, select.json.error], [501, "action unavailable"], "select without sessions: 501");

  commandError = Object.assign(new Error("permission needed"), { status: 409, body: { error: "permission needed", player: "spotify", status: "needed" } });
  const blocked = await h.req("/api/media", { action: "next" });
  t.equal(blocked.status, 409, "a player not yet allowed: 409");
  t.deepEqual(blocked.json, { error: "permission needed", player: "spotify", status: "needed" }, "409 carries the player and status");
  commandError = null;

  const before = p.calls.launch.length;
  const opened = await h.req("/api/media", { action: "open", value: "spotify" });
  t.equal(opened.status, 200, "open launches an installed player");
  t.deepEqual(p.calls.launch.slice(before), ["com.spotify.client"], "open launches the catalog app by id");
  t.equal((await h.req("/api/media", { action: "open", value: "music" })).status, 404, "open of a player not in the map: 404");

  // Artwork: validation, cache, content checks.
  for (const bad of ["", "nothex", artKey.toUpperCase(), "../" + artKey, artKey + "&x=1"]) {
    t.equal((await h.req(`/api/media/artwork?key=${encodeURIComponent(bad)}`)).status, 400, `artwork key rejected: ${JSON.stringify(bad)}`);
  }
  t.equal(p.calls.artwork.length, 0, "rejected keys never reach the provider");
  const art = await h.req(`/api/media/artwork?key=${artKey}`);
  t.equal(art.status, 200, "valid artwork key: 200");
  t.equal(art.headers.get("content-type"), "image/png", "artwork content type from the bytes");
  t.equal(art.headers.get("x-content-type-options"), "nosniff", "artwork is nosniff");
  t.ok(art.buf.equals(png(300, 300)), "artwork bytes are served as is");
  await h.req(`/api/media/artwork?key=${artKey}`);
  t.equal(p.calls.artwork.length, 1, "artwork is cached by key");
  t.equal((await h.req(`/api/media/artwork?key=${"0".repeat(32)}`)).status, 404, "non-image bytes from a provider are refused");
  t.equal((await h.req(`/api/media/artwork?key=${"1".repeat(32)}`)).status, 404, "an unknown key: 404");
  await h.stop();

  const none = fakeProvider({ features: {} });
  const h2 = await serve(none);
  t.equal((await h2.req("/api/media")).status, 501, "a host without media: 501");
  t.equal((await h2.req("/api/media", { action: "toggle" })).status, 501, "POST on a host without media: 501");
  t.equal((await h2.req(`/api/media/artwork?key=${artKey}`)).status, 501, "artwork on a host without media: 501");
  t.deepEqual((await h2.req("/api/nowplaying")).json, { nowPlaying: { title: "legacy", artist: "", playing: false } }, "without media, /api/nowplaying keeps the provider's nowPlaying()");
  t.equal((await h2.req("/api/volume")).status, 501, "a host without volume: 501");
  await h2.stop();
}
{
  // Flicker regression: a read that started before a command must not cache its stale state.
  let state = { source: { id: "spotify", name: "Spotify", appId: "com.spotify.client", sessionId: null }, title: "T", playing: true, controls: {} };
  let releaseSlow = null;
  const p = fakeProvider({
    async media() {
      p.calls.media += 1;
      const snapshot = state;
      if (p.calls.media === 1) await new Promise((r) => { releaseSlow = r; });
      return snapshot;
    },
    async mediaCommand(action) { if (action === "pause") state = { ...state, playing: false }; },
  });
  const h = await serve(p, { mediaCacheMs: 10_000 });
  const slowGet = h.req("/api/media"); // starts reading "playing", stays in flight
  await until(() => releaseSlow, "slow read started");
  const paused = await h.req("/api/media", { action: "pause" });
  t.equal(paused.json.playing, false, "the command reply is the new state");
  releaseSlow();
  t.equal((await slowGet).json.playing, true, "the old read still answers its own request");
  t.equal((await h.req("/api/media")).json.playing, false, "a stale read that finished after the command never replaces the cached state");
  await h.stop();
}

// =========================================================================
// 5. volume
// =========================================================================
{
  let level = 45;
  let muted = false;
  const p = fakeProvider({
    async volume() { p.calls.volume += 1; return { level, muted }; },
    async setVolume(v) { p.calls.setVolume.push(v); if (v.level !== undefined) level = v.level; if (v.muted !== undefined) muted = v.muted; return { level, muted }; },
  });
  const h = await serve(p);
  t.deepEqual((await h.req("/api/volume")).json, { level: 45, muted: false }, "GET /api/volume");
  t.deepEqual((await h.req("/api/volume", { level: 30 })).json, { level: 30, muted: false }, "POST level returns the new state");
  t.deepEqual((await h.req("/api/volume", { muted: true })).json, { level: 30, muted: true }, "POST muted returns the new state");
  t.equal((await h.req("/api/volume", { level: 300 })).status, 400, "an out-of-range level: 400");
  t.equal((await h.req("/api/volume", {}, "POST")).status, 400, "an empty volume body: 400");
  t.deepEqual(p.calls.setVolume, [{ level: 30, muted: undefined }, { level: undefined, muted: true }], "the provider gets exactly what was asked");
  await h.stop();

  const noMute = fakeProvider({ features: { volume: { get: true, set: true, mute: false } }, async setVolume() { throw new Error("must not be called"); }, async volume() { return { level: 10, muted: null }; } });
  const h2 = await serve(noMute);
  const mute = await h2.req("/api/volume", { muted: true });
  t.deepEqual([mute.status, mute.json.error], [501, "mute unavailable"], "mute on a host that cannot mute: 501");
  t.deepEqual((await h2.req("/api/volume")).json, { level: 10, muted: null }, "an unknown mute state is null");
  await h2.stop();
}

// Windows provider: the media-state / media-command / media-artwork helper
// verbs, volume with mute, lock state, and the old verbs as fallbacks.
{
  const statusOf = async (fn) => { try { await fn(); return "resolved"; } catch (err) { return err?.status ?? "no-status"; } };
  const KEY = "0123456789abcdef0123456789abcdef";
  const spotifyPath = "C:\\Users\\Me\\AppData\\Roaming\\Spotify\\Spotify.exe";
  const sessionRow = (over = {}) => ({
    sessionId: "Spotify.exe", name: "Spotify", path: spotifyPath, current: true,
    title: "Houdini", artist: "Dua Lipa", album: "Radical Optimism", status: "playing",
    positionMs: 72000, durationMs: 185000, updatedAt: 1_000_000, shuffle: true, repeat: "all",
    controls: { previous: true, next: true, playPause: true, seek: true, shuffle: true, repeat: true },
    artworkKey: KEY, ...over,
  });
  const chromeRow = (over = {}) => sessionRow({
    sessionId: "Chrome", name: "Google Chrome", path: null, current: false, title: "A video", artist: "", album: "",
    status: "paused", durationMs: null, positionMs: null, updatedAt: null, shuffle: null, repeat: null,
    controls: { previous: false, next: false, playPause: true, seek: false, shuffle: false, repeat: false }, artworkKey: null, ...over,
  });
  let state = { current: "Spotify.exe", sessions: [sessionRow(), chromeRow()] };
  let stateRaw = null;
  let commandOut = '{"ok":true}';
  let artworkOut = "";
  let helperIsOld = false;
  const calls = [];
  const win = createWindowsProvider({
    helperPath: "H.exe",
    now: () => 2_000_000,
    exec: async (file, args) => {
      calls.push(args);
      t.equal(file, "H.exe", `every Windows call goes to the helper (${args[0]})`);
      const newVerbs = ["media-state", "media-command", "media-artwork", "volume-mute", "session-locked"];
      if (helperIsOld && newVerbs.includes(args[0])) {
        const err = new Error("exit 1"); err.stderr = `unknown verb: ${args[0]}`; throw err;
      }
      switch (args[0]) {
        case "volume": return { stdout: '{"volume":0.45,"muted":false}' };
        case "volume-mute": return { stdout: `{"volume":0.45,"muted":${args[1]}}` };
        case "nowplaying": return { stdout: '{"title":"Song","artist":"Band","playing":true}' };
        case "media-state": return { stdout: stateRaw ?? JSON.stringify(state) };
        case "media-command": return { stdout: commandOut };
        case "media-artwork": return { stdout: artworkOut };
        case "session-locked": return { stdout: '{"locked":true}' };
        case "close": return { stdout: '{"windows":3}' };
        default: return { stdout: "" };
      }
    },
  });

  // volume and mute
  t.deepEqual(await win.volume(), { level: 45, muted: false }, "Windows volume reads level and mute");
  t.deepEqual(calls.at(-1), ["volume"], "volume read argv");
  calls.length = 0;
  t.deepEqual(await win.setVolume({ muted: true }), { level: 45, muted: true }, "mute returns the new state");
  t.deepEqual(calls, [["volume-mute", "true"]], "mute argv is exact");
  calls.length = 0;
  await win.setVolume({ level: 40, muted: false });
  t.deepEqual(calls, [["control", "volume-set", "40"], ["volume-mute", "false"]], "level and mute together: both verbs, in order");
  calls.length = 0;
  await win.setVolume({ level: 40 });
  t.deepEqual(calls, [["control", "volume-set", "40"], ["volume"]], "level alone sets, then reads back");
  await t.rejects(() => win.setVolume({}), "setVolume with nothing to do is refused");
  await t.rejects(() => win.setVolume({ level: 101 }), "an out-of-range level is refused");

  // lock state
  calls.length = 0;
  t.deepEqual(await win.sessionState(), { locked: true }, "session-locked maps to { locked }");
  t.deepEqual(calls, [["session-locked"]], "session-locked argv");

  // close reports the window count
  calls.length = 0;
  t.deepEqual(await win.closeApp({ pid: 77 }), { windows: 3 }, "close reports how many windows were asked to close");
  t.deepEqual(calls, [["close", "77"]], "close argv is unchanged");

  // rich media state
  calls.length = 0;
  const media = normalizeMediaState(await win.media());
  t.deepEqual(calls, [["media-state"]], "media reads media-state only");
  t.deepEqual(media.source, { id: "system", name: "Spotify", appId: "c:/users/me/appdata/roaming/spotify/spotify.exe", sessionId: "Spotify.exe" }, "the source names the session and its catalog app id");
  t.deepEqual([media.title, media.artist, media.album, media.playing, media.positionMs, media.durationMs, media.updatedAt], ["Houdini", "Dua Lipa", "Radical Optimism", true, 72000, 185000, 1_000_000], "track, timeline and when it was read");
  t.deepEqual([media.shuffle, media.repeat, media.repeatModes], [true, "all", ["off", "all", "one"]], "shuffle and repeat (all three modes)");
  t.deepEqual(media.controls, { previous: true, next: true, playPause: true, seek: true, shuffle: true, repeat: true }, "controls follow the session");
  t.equal(media.artwork, mediaArtworkPath(KEY), "artwork is a host path for the helper's key");
  t.deepEqual(media.sessions, [
    { sessionId: "Spotify.exe", name: "Spotify", appId: "c:/users/me/appdata/roaming/spotify/spotify.exe", title: "Houdini", current: true },
    { sessionId: "Chrome", name: "Google Chrome", appId: null, title: "A video", current: false },
  ], "every session is listed; the shown one is current");

  // packaged source ids map to the packaged catalog id
  state = { current: "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic", sessions: [sessionRow({ sessionId: "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic", name: "Media Player", path: null })] };
  t.equal(normalizeMediaState(await win.media()).source.appId, "shell:appsfolder/microsoft.zunemusic_8wekyb3d8bbwe!microsoft.zunemusic", "a packaged session maps to its AppsFolder id");

  // seek / shuffle / repeat only when the session can
  state = { current: "Chrome", sessions: [sessionRow({ current: false }), chromeRow()] };
  const chrome = normalizeMediaState(await win.media());
  t.equal(chrome.source.sessionId, "Chrome", "Windows' current session is shown");
  t.deepEqual([chrome.controls.seek, chrome.controls.shuffle, chrome.controls.repeat, chrome.shuffle, chrome.repeat, chrome.repeatModes], [false, false, false, null, null, undefined], "no seek, shuffle or repeat when the session does not report them");
  t.equal(chrome.updatedAt, 2_000_000, "no timeline timestamp: updatedAt is now");
  t.equal(chrome.artwork, null, "no thumbnail: no artwork");
  state = { current: "Chrome", sessions: [sessionRow({ current: false, updatedAt: 9_000_000 }), chromeRow({ title: "" })] };
  const fallback = normalizeMediaState(await win.media());
  t.equal(fallback.source.sessionId, "Spotify.exe", "a current session without a track yields to one with a track");
  t.equal(fallback.updatedAt, 2_000_000, "a timestamp in the future is clamped to now");

  // session selection (stateless helper, remembered by the provider)
  state = { current: "Spotify.exe", sessions: [sessionRow(), chromeRow()] };
  calls.length = 0;
  await win.mediaCommand("select", "Chrome", "Chrome");
  t.deepEqual(calls, [["media-state"]], "select checks the session exists and runs no command");
  t.equal(normalizeMediaState(await win.media()).source.sessionId, "Chrome", "the selected session is shown");
  calls.length = 0;
  await win.mediaCommand("next", null, null);
  t.deepEqual(calls, [["media-command", "next", "", "Chrome"]], "commands go to the selected session (empty value placeholder)");
  calls.length = 0;
  await win.mediaCommand("toggle", null, "Spotify.exe");
  t.deepEqual(calls, [["media-command", "toggle", "", "Spotify.exe"]], "an explicit sessionId wins");
  t.equal(await statusOf(() => win.mediaCommand("select", "Nope.exe", "Nope.exe")), 404, "selecting an unknown session: 404");
  t.equal(await statusOf(() => win.mediaCommand("select", "bad id", "bad id")), 400, "a malformed session id is refused before the helper");
  state = { current: "Spotify.exe", sessions: [sessionRow()] };
  t.equal(normalizeMediaState(await win.media()).source.sessionId, "Spotify.exe", "a selected session that ended is forgotten");
  calls.length = 0;
  await win.mediaCommand("pause", null, null);
  t.deepEqual(calls, [["media-command", "pause"]], "no selection, no sessionId: the helper uses the current session");

  // exact argv per action
  calls.length = 0;
  await win.mediaCommand("play", null, null);
  await win.mediaCommand("previous", null, null);
  await win.mediaCommand("seek", 61000, null);
  await win.mediaCommand("shuffle", false, null);
  await win.mediaCommand("repeat", "one", "Spotify.exe");
  t.deepEqual(calls, [
    ["media-command", "play"],
    ["media-command", "previous"],
    ["media-command", "seek", "61000"],
    ["media-command", "shuffle", "false"],
    ["media-command", "repeat", "one", "Spotify.exe"],
  ], "media-command argv is exact for every action");
  calls.length = 0;
  for (const [action, value] of [["seek", -1], ["seek", 1.5], ["seek", "100"], ["shuffle", "true"], ["repeat", "track"]]) {
    t.equal(await statusOf(() => win.mediaCommand(action, value, null)), 400, `invalid ${action} value ${JSON.stringify(value)} refused`);
  }
  t.equal(await statusOf(() => win.mediaCommand("open", "spotify", null)), 501, "open is the host's job");
  t.deepEqual(calls, [], "invalid commands never reach the helper");

  // helper outcomes
  commandOut = '{"ok":false,"error":"no-session"}';
  t.equal(await statusOf(() => win.mediaCommand("next", null, null)), 404, "no session: 404");
  commandOut = '{"ok":false,"error":"unknown-session"}';
  t.equal(await statusOf(() => win.mediaCommand("next", null, "Gone.exe")), 404, "unknown session: 404");
  commandOut = '{"ok":false,"error":"rejected"}';
  t.equal(await statusOf(() => win.mediaCommand("shuffle", true, null)), 501, "the app refused: 501");
  for (const bad of ["", "not json", "[1]", '{"ok":"yes"}', `{"ok":true,"pad":"${"x".repeat(5000)}"}`]) {
    commandOut = bad;
    t.equal(await statusOf(() => win.mediaCommand("next", null, null)), 502, `malformed command output refused: ${JSON.stringify(bad.slice(0, 20))}`);
  }
  commandOut = '{"ok":true}';

  // malformed / oversized media-state falls back to the old verbs
  for (const bad of ["", "nope", "[]", '{"sessions":5}', JSON.stringify({ current: null, sessions: [], pad: "x".repeat(300 * 1024) })]) {
    stateRaw = bad;
    calls.length = 0;
    const m = normalizeMediaState(await win.media());
    t.deepEqual([m.source?.id, m.title, calls.map((c) => c[0])], ["system", "Song", ["media-state", "nowplaying"]], `unusable media-state (${bad.length} chars) falls back to nowplaying`);
  }
  stateRaw = JSON.stringify({ current: "x", sessions: [
    { sessionId: "bad id", title: "Space" },
    { sessionId: 7, title: "Number" },
    sessionRow({ sessionId: "A.exe", status: "dancing", positionMs: -5, durationMs: "185000", shuffle: "yes", repeat: "track", artworkKey: "ZZ", controls: { seek: "true" }, name: 5, path: "relative\\a.exe" }),
    sessionRow({ sessionId: "A.exe", title: "Duplicate" }),
  ] });
  const parsed = parseMediaState(stateRaw);
  t.deepEqual(parsed.sessions.map((s) => s.sessionId), ["A.exe"], "invalid and duplicate session ids are dropped");
  t.deepEqual([parsed.current, parsed.sessions[0].current], [null, false], "a current id that is not listed is ignored");
  const a = parsed.sessions[0];
  t.deepEqual([a.status, a.positionMs, a.durationMs, a.shuffle, a.repeat, a.artworkKey, a.controls.seek, a.name, a.appId], ["closed", null, null, null, null, null, false, null, null], "every field is type-checked");
  stateRaw = JSON.stringify({ current: null, sessions: Array.from({ length: 30 }, (_, i) => sessionRow({ sessionId: `P${i}.exe`, current: false })) });
  t.equal(parseMediaState(stateRaw).sessions.length, 16, "at most 16 sessions");
  stateRaw = JSON.stringify({ current: null, sessions: [chromeRow({ title: "" })] });
  const nothing = normalizeMediaState(await win.media());
  t.deepEqual([nothing.source, nothing.controls.playPause, nothing.sessions.length], [null, true, 1], "sessions without a track: no source, resume still offered");
  stateRaw = null;

  // artwork: key -> session, signature, size and staleness checks
  state = { current: "Spotify.exe", sessions: [sessionRow()] };
  await win.media();
  const art = (bytes, over = {}) => JSON.stringify({ ok: true, key: KEY, mime: imageInfo(bytes)?.mime ?? "image/png", data: bytes.toString("base64"), ...over });
  artworkOut = art(png(300, 300));
  calls.length = 0;
  const served = await win.mediaArtwork(KEY);
  t.deepEqual(calls, [["media-artwork", "Spotify.exe"]], "artwork argv names the session the key came from");
  t.deepEqual([served?.mime, imageInfo(served?.bytes)?.width], ["image/png", 300], "a small PNG is served");
  artworkOut = art(jpeg(512, 400));
  t.equal((await win.mediaArtwork(KEY))?.mime, "image/jpeg", "a 512 px JPEG is served");
  const refused = [
    ["larger than 512 px", art(png(513, 100))],
    ["not an image", art(Buffer.from("GIF89a-not-allowed-here-xxxxxxxxx"), { mime: "image/gif" })],
    ["mime mismatch", art(png(100, 100), { mime: "image/jpeg" })],
    ["stale key (track changed)", art(png(100, 100), { key: "f".repeat(32) })],
    ["not ok", JSON.stringify({ ok: false, error: "no-artwork" })],
    ["bad base64", art(png(100, 100), { data: "!!!!" })],
    ["over 2 MB", art(Buffer.concat([png(100, 100), Buffer.alloc(2 * 1024 * 1024)]))],
    ["malformed", "{"],
  ];
  for (const [label, out] of refused) {
    artworkOut = out;
    t.equal(await win.mediaArtwork(KEY), null, `artwork refused: ${label}`);
  }
  calls.length = 0;
  t.equal(await win.mediaArtwork("e".repeat(32)), null, "an unknown key yields no artwork");
  t.equal(await win.mediaArtwork("../../etc"), null, "a malformed key yields no artwork");
  t.deepEqual(calls, [], "unknown keys never reach the helper");

  // an older helper (no new verbs): media keys and nowplaying still work
  helperIsOld = true;
  const old = normalizeMediaState(await win.media());
  t.deepEqual([old.source.id, old.title, old.artist, old.playing, old.artwork, old.sessions], ["system", "Song", "Band", true, null, []], "older helper: media from nowplaying");
  calls.length = 0;
  await win.mediaCommand("toggle", null, null);
  await win.mediaCommand("next", null, null);
  t.deepEqual(calls, [["media-command", "toggle"], ["control", "media-play-pause"], ["media-command", "next"], ["control", "media-next"]], "older helper: transport falls back to media keys");
  calls.length = 0;
  await win.mediaCommand("play", null, null);
  t.deepEqual(calls, [["media-command", "play"], ["nowplaying"]], "older helper: play while playing sends no key");
  t.equal(await statusOf(() => win.mediaCommand("seek", 1000, null)), 501, "older helper: seek unavailable");
  t.equal(await win.sessionState(), null, "older helper: lock state unknown");
  helperIsOld = false;
}

// =========================================================================
// 6. permissions
// =========================================================================
{
  let granted = false;
  const p = fakeProvider({
    async requestPermission(scope) { p.calls.permission.push(scope); granted = true; return scope === "music" ? "not-running" : "granted"; },
    async openPermissionSettings(scope) { p.calls.settings.push(scope); },
    featureState: async () => ({ power: { restart: granted ? "ready" : "needs-permission" } }),
  });
  const h = await serve(p);
  const d = await h.dock();
  for (const bad of ["finder", "", "System-Events", "spotify ", 1]) {
    t.equal((await h.req("/api/permissions/request", { scope: bad })).status, 400, `scope refused: ${JSON.stringify(bad)}`);
  }
  t.equal((await h.req("/api/permissions/request", null, "POST")).status, 415, "permissions need a JSON body");
  t.deepEqual(p.calls.permission, [], "refused scopes never reach the provider");
  const before = d.messages.length;
  const asked = await h.req("/api/permissions/request", { scope: "system-events" });
  t.deepEqual([asked.status, asked.json], [200, { scope: "system-events", status: "granted" }], "a request reports the answer");
  await until(() => d.messages.length > before, "broadcast after the permission changed");
  t.equal(d.messages.at(-1).features.power.restart, "ready", "the broadcast carries the granted status");
  const notRunning = await h.req("/api/permissions/request", { scope: "music" });
  t.deepEqual([notRunning.status, notRunning.json.error], [409, "not running"], "asking for a player that is not running: 409");
  const settings = await h.req("/api/permissions/open-settings", { scope: "spotify" });
  t.deepEqual([settings.status, p.calls.settings], [200, ["spotify"]], "open-settings reaches the provider");
  t.equal((await h.req("/api/permissions/open-settings", { scope: "nope" })).status, 400, "open-settings validates the scope");
  const cross = await h.req("/api/permissions/request", { scope: "spotify" }, "POST", { origin: "http://evil.example" });
  t.equal(cross.status, 403, "a cross-origin permission request is refused");
  await h.stop();

  const h2 = await serve(fakeProvider());
  t.equal((await h2.req("/api/permissions/request", { scope: "spotify" })).status, 501, "a host without permissions: 501");
  await h2.stop();
}

// =========================================================================
// 7. power: reply first, run after 500 ms; lock is not destructive
// =========================================================================
{
  const timers = fakeTimers();
  let status = "ready";
  const p = fakeProvider({ powerStatus: async () => status });
  const h = await serve(p, { timers, allowDestructive: true });
  const reply = await h.req("/api/control", { verb: "shutdown" });
  t.deepEqual([reply.status, reply.json], [200, { ok: true, verb: "shutdown", expectDisconnect: true }], "shutdown is acknowledged with expectDisconnect");
  t.equal(p.calls.control.length, 0, "the reply arrives before shutdown runs");
  t.equal(timers.count(500), 1, "shutdown waits exactly 500 ms");
  timers.fire(500);
  await until(() => p.calls.control.length === 1, "deferred shutdown");
  t.deepEqual(p.calls.control[0], ["shutdown", null], "shutdown runs after the delay");
  for (const verb of ["sleep", "restart"]) {
    const r = await h.req("/api/control", { verb });
    t.ok(r.status === 200 && r.json.expectDisconnect === true && timers.count(500) === 1, `${verb} is deferred too`);
    timers.fire(500);
  }
  await until(() => p.calls.control.length === 3, "deferred sleep and restart");
  const lock = await h.req("/api/control", { verb: "lock" });
  t.deepEqual([lock.status, lock.json], [200, { ok: true, verb: "lock" }], "lock runs at once, no expectDisconnect");
  t.deepEqual(p.calls.control.at(-1), ["lock", null], "lock ran before the reply");

  status = "needs-permission";
  const ask = await h.req("/api/control", { verb: "shutdown" });
  t.deepEqual([ask.status, ask.json], [409, { error: "permission needed", scope: "system-events", status: "needed" }], "a Mac without System Events permission: 409");
  t.equal(timers.count(500), 1, "the host still tries (the prompt on the Mac carries it out)");
  timers.fire(500);
  status = "denied";
  const callsBefore = p.calls.control.length;
  const denied = await h.req("/api/control", { verb: "restart" });
  t.deepEqual([denied.status, denied.json.status], [409, "denied"], "a denied permission: 409 status denied");
  await sleep(10);
  t.equal(timers.count(500), 0, "a denied power action is not attempted");
  t.ok(p.calls.control.length <= callsBefore + 1, "no extra attempt after denial");
  await h.stop();

  const timers2 = fakeTimers();
  const p2 = fakeProvider();
  const h2 = await serve(p2, { timers: timers2, allowDestructive: false });
  t.equal((await h2.req("/api/control", { verb: "lock" })).status, 200, "lock works with power actions disabled");
  t.equal((await h2.req("/api/control", { verb: "sleep" })).status, 403, "sleep stays disabled with power actions disabled");
  t.equal((await h2.req("/api/control", { verb: "shutdown" })).status, 403, "shutdown stays disabled with power actions disabled");
  await h2.stop();

  // A provider's controlVerbs narrow what the host advertises and accepts.
  const p3 = fakeProvider({ controlVerbs: ["lock", "volume-up"] });
  const h3 = await serve(p3);
  t.deepEqual((await h3.req("/api/state")).json.verbs, ["volume-up", "lock"], "verbs follow controlVerbs (in contract order)");
  t.equal((await h3.req("/api/control", { verb: "brightness-set", value: 50 })).status, 501, "an unmapped verb: 501");
  await h3.stop();
}

// =========================================================================
// 8. macOS provider: constant scripts, running-first, exact argv
// =========================================================================
const SCRIPTS = { PERMISSION_JXA, SPOTIFY_STATE_JXA, SPOTIFY_COMMAND_JXA, MUSIC_STATE_JXA, MUSIC_COMMAND_JXA, MUSIC_ARTWORK_AS, VOLUME_GET_AS, VOLUME_SET_AS, POWER_AS, LOCK_JXA, SESSION_JXA };
for (const [name, script] of Object.entries(SCRIPTS)) {
  t.ok(script.includes("function run(argv)") || script.includes("on run argv"), `${name} reads data from argv only`);
  t.ok(!script.includes("${") && !script.includes("`"), `${name} is a constant (no interpolation)`);
}
for (const [name, script] of Object.entries({ SPOTIFY_STATE_JXA, SPOTIFY_COMMAND_JXA, MUSIC_STATE_JXA, MUSIC_COMMAND_JXA })) {
  const running = script.indexOf("if (!app.running())");
  const perm = script.indexOf("permission('com.");
  const firstEvent = Math.min(...["app.currentTrack", "app.playpause", "app.play()", "app.nextTrack"].map((s) => script.indexOf(s)).filter((i) => i >= 0));
  t.ok(running > 0 && running < perm && perm < firstEvent, `${name}: running check, then permission check, then the first Apple event`);
}
t.ok(MUSIC_ARTWORK_AS.indexOf("is not running") < MUSIC_ARTWORK_AS.indexOf("tell application"), "the Music artwork script checks running before its tell block");
t.ok(!/\bactivate\b|\blaunch\b|\breopen\b/.test(SPOTIFY_STATE_JXA + MUSIC_STATE_JXA + SPOTIFY_COMMAND_JXA + MUSIC_COMMAND_JXA + MUSIC_ARTWORK_AS), "no player script ever launches or activates a player");
t.ok(PERMISSION_JXA.includes("mode === 'ask'") && PERMISSION_JXA.includes("allowed.indexOf(id) < 0"), "the permission script prompts only in ask mode, for allowlisted targets");
t.deepEqual(appleScriptArgv("S", ["a"]), ["-l", "AppleScript", "-e", "S", "--", "a"], "AppleScript argv ends options before data");
t.deepEqual(MAC_CONTROL_VERBS, CONTROL_VERBS.filter((v) => v !== "brightness-set"), "macOS maps every verb but brightness");
t.equal(permissionFromCode(0), "granted", "AE 0 is granted");
t.equal(permissionFromCode(-1743), "denied", "-1743 is denied");
t.equal(permissionFromCode(-1744), "needed", "-1744 needs consent");
t.equal(permissionFromCode(-600), "not-running", "-600 is not running");
t.deepEqual(parseVolume("45,false"), { level: 45, muted: false }, "volume output parses");
t.deepEqual(parseVolume("missing value,true"), { level: null, muted: true }, "an output without volume control parses to null");

const SPOTIFY_RUNNING = JSON.stringify([{ pid: 700, name: "Spotify", bundleId: "com.spotify.client", path: "/Applications/Spotify.app" }]);
const BOTH_RUNNING = JSON.stringify([
  { pid: 700, name: "Spotify", bundleId: "com.spotify.client", path: "/Applications/Spotify.app" },
  { pid: 701, name: "Music", bundleId: "com.apple.Music", path: "/System/Applications/Music.app" },
  { pid: 702, name: "Finder", bundleId: "com.apple.finder", path: "/System/Library/CoreServices/Finder.app" },
]);
function macRecorder(responses) {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    const script = args[3];
    const handler = responses.find(([match]) => (typeof match === "function" ? match(file, args) : script === match));
    if (!handler) return { stdout: "" };
    const out = typeof handler[1] === "function" ? await handler[1](file, args) : handler[1];
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { calls, exec };
}
const spotifyRow = (over = {}) => JSON.stringify({
  running: true, permission: 0, state: "playing", name: "Houdini", artist: "Dua Lipa", album: "Radical Optimism",
  durationMs: 185000, trackId: "spotify:track:1", artworkUrl: "https://i.scdn.co/image/ab67", position: 72.4, shuffle: true, repeat: false, ...over,
});

{
  // Nothing running: no player script at all.
  const rec = macRecorder([[RUNNING_JXA, "[]"]]);
  const mac = createMacProvider({ exec: rec.exec, appDirs: [] });
  const state = normalizeMediaState(await mac.media());
  t.equal(state.source, null, "no player running: nothing playing");
  t.deepEqual(rec.calls.map((c) => c.args[3]), [RUNNING_JXA], "with no player running, only the running list is read");
  await t.rejects(() => mac.mediaCommand("toggle", null, null), "a command with no player running is refused");
  t.ok(!rec.calls.some((c) => [SPOTIFY_COMMAND_JXA, MUSIC_COMMAND_JXA, SPOTIFY_STATE_JXA, MUSIC_STATE_JXA].includes(c.args[3])), "no player is ever scripted (or launched) when none is running");
}
{
  // Spotify running and playing.
  const rec = macRecorder([[RUNNING_JXA, SPOTIFY_RUNNING], [SPOTIFY_STATE_JXA, spotifyRow()], [SPOTIFY_COMMAND_JXA, '{"running":true,"permission":0,"ok":true}']]);
  const mac = createMacProvider({ exec: rec.exec, appDirs: [], now: () => 1000 });
  const state = normalizeMediaState(await mac.media(), 1000);
  t.deepEqual(rec.calls.map((c) => c.args[3]), [RUNNING_JXA, SPOTIFY_STATE_JXA], "running list first, then only the running player's script");
  t.deepEqual(rec.calls[1].args, osascriptArgv(SPOTIFY_STATE_JXA), "the Spotify read carries no caller data");
  t.deepEqual(state.source, { id: "spotify", name: "Spotify", appId: "com.spotify.client", sessionId: null }, "Spotify is the source");
  t.deepEqual([state.title, state.artist, state.album, state.playing, state.positionMs, state.durationMs], ["Houdini", "Dua Lipa", "Radical Optimism", true, 72400, 185000], "Spotify fields map to 8.3");
  t.deepEqual([state.shuffle, state.repeat, state.repeatModes], [true, "off", ["off", "all"]], "Spotify shuffle/repeat (no repeat-one)");
  t.equal(state.artwork, mediaArtworkPath(artworkKey("spotify", "https://i.scdn.co/image/ab67")), "Spotify artwork becomes a host path");
  t.equal(state.controls.seek, true, "seek is offered with a duration");
  rec.calls.length = 0;
  await mac.mediaCommand("seek", 12000, null);
  t.deepEqual(rec.calls.at(-1).args, osascriptArgv(SPOTIFY_COMMAND_JXA, ["seek", "12000"]), "seek argv: action and ms as separate entries");
  t.ok(rec.calls.findIndex((c) => c.args[3] === RUNNING_JXA) < rec.calls.findIndex((c) => c.args[3] === SPOTIFY_COMMAND_JXA), "a command checks running before scripting the player");
  await mac.mediaCommand("shuffle", false, null);
  t.deepEqual(rec.calls.at(-1).args.slice(5), ["shuffle", "false"], "shuffle argv");
  await mac.mediaCommand("repeat", "all", null);
  t.deepEqual(rec.calls.at(-1).args.slice(5), ["repeat", "all"], "repeat argv");
  await t.rejects(() => mac.mediaCommand("select", "x", null), "select is not offered on a Mac");
}
{
  // Flicker regression: right after playpause Spotify can still report the old state;
  // the command waits (<= 800 ms, 100 ms steps) until the player shows the change.
  let clock = 0, reads = 0, commanded = false;
  const states = ["playing", "playing", "paused"];
  const rec = macRecorder([[RUNNING_JXA, SPOTIFY_RUNNING],
    [SPOTIFY_STATE_JXA, () => spotifyRow({ state: commanded ? states[Math.min(reads++, states.length - 1)] : "playing" })],
    [SPOTIFY_COMMAND_JXA, () => { commanded = true; return '{"running":true,"permission":0,"ok":true}'; }]]);
  const sleeps = [];
  const mac = createMacProvider({ exec: rec.exec, appDirs: [], now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  await mac.mediaCommand("toggle", null, null);
  t.equal(reads, 3, "toggle re-reads the player until it reports the change");
  t.deepEqual(sleeps, [100, 100], "re-reads are 100 ms apart");
  t.equal(normalizeMediaState(await mac.media()).playing, false, "the state read right after the command is the new one");
  // A player that never changes: give up after 800 ms.
  clock = 0; reads = 0; sleeps.length = 0; states.splice(0, 3, "playing");
  await mac.mediaCommand("toggle", null, null);
  t.ok(clock >= 800 && clock <= 900 && sleeps.every((ms) => ms === 100), "the wait is capped at about 800 ms");
  // Seek and next do not wait.
  reads = 0; sleeps.length = 0;
  await mac.mediaCommand("next", null, null);
  t.deepEqual([reads, sleeps.length], [1, 0], "next reads the player once (to pick it) and does not wait for a state change");
}
{
  // Permission not granted yet: no state, a permission hint, a 409 on commands.
  const rec = macRecorder([[RUNNING_JXA, SPOTIFY_RUNNING], [SPOTIFY_STATE_JXA, '{"running":true,"permission":-1744}'], [SPOTIFY_COMMAND_JXA, '{"running":true,"permission":-1744}']]);
  const mac = createMacProvider({ exec: rec.exec, appDirs: [] });
  const state = normalizeMediaState(await mac.media());
  t.deepEqual([state.source, state.permission], [null, { player: "spotify", status: "needed" }], "a running player without permission: permission needed");
  let error = null;
  try { await mac.mediaCommand("toggle", null, null); } catch (e) { error = e; }
  t.deepEqual([error?.status, error?.body], [409, { error: "permission needed", player: "spotify", status: "needed" }], "a command before permission: 409");
  const denied = macRecorder([[RUNNING_JXA, SPOTIFY_RUNNING], [SPOTIFY_STATE_JXA, '{"running":true,"permission":-1743}']]);
  const mac2 = createMacProvider({ exec: denied.exec, appDirs: [] });
  t.deepEqual(normalizeMediaState(await mac2.media()).permission, { player: "spotify", status: "denied" }, "-1743 maps to denied");
}
{
  // Both players: the playing one wins; else the most recently paused one.
  let spotify = spotifyRow({ state: "paused" });
  let music = JSON.stringify({ running: true, permission: 0, state: "playing", name: "Song", artist: "A", album: "B", duration: 200.5, persistentId: "ABCDEF0123456789", artworkCount: 1, position: 3, shuffle: false, repeat: "one" });
  let clock = 1000;
  const rec = macRecorder([[RUNNING_JXA, BOTH_RUNNING], [SPOTIFY_STATE_JXA, () => spotify], [MUSIC_STATE_JXA, () => music]]);
  const mac = createMacProvider({ exec: rec.exec, appDirs: [], now: () => clock });
  let state = normalizeMediaState(await mac.media());
  t.equal(state.source.id, "music", "the playing player is the source");
  t.deepEqual([state.durationMs, state.repeat, state.repeatModes], [200500, "one", ["off", "all", "one"]], "Music fields map (seconds to ms, repeat one)");
  t.equal(state.artwork, mediaArtworkPath(artworkKey("music", "ABCDEF0123456789")), "Music artwork key from the persistent ID");
  clock = 2000;
  spotify = spotifyRow({ state: "playing" });
  await mac.media();
  clock = 3000;
  spotify = spotifyRow({ state: "paused" });
  music = music.replace('"playing"', '"paused"');
  state = normalizeMediaState(await mac.media());
  t.equal(state.source.id, "spotify", "when both are paused, the one that played last is the source");
  t.equal(state.playing, false, "paused state is reported");
}
{
  // featureState: installed from the catalog, running from the list, permissions without prompting.
  const rec = macRecorder([[PERMISSION_JXA, '{"com.spotify.client":0,"com.apple.systemevents":-1744}']]);
  const mac = createMacProvider({ exec: rec.exec, appDirs: [], now: () => 5 });
  const live = await mac.featureState({
    installed: [{ id: "com.spotify.client" }, { id: "com.apple.Music" }],
    running: [{ bundleId: "com.spotify.client", pid: 700 }],
  });
  t.deepEqual(rec.calls[0].args, osascriptArgv(PERMISSION_JXA, ["check", "com.spotify.client", "com.apple.systemevents"]), "featureState checks running players and System Events, in check mode (no prompt)");
  t.deepEqual(live.players, [
    { id: "spotify", name: "Spotify", appId: "com.spotify.client", installed: true, running: true, permission: "granted" },
    { id: "music", name: "Music", appId: "com.apple.Music", installed: true, running: false, permission: "needed" },
  ], "players: installed, running and permission");
  t.deepEqual(live.power, { restart: "needs-permission", shutdown: "needs-permission" }, "System Events not yet allowed: needs-permission");
  t.equal(live.spotify.installed, true, "spotify.installed from the catalog");
  const map = featuresOf(mac, live);
  t.deepEqual(map.power, { lock: "ready", sleep: "ready", restart: "needs-permission", shutdown: "needs-permission" }, "macOS power map (7.2)");
  t.equal(map.media.sources, "apps", "macOS media sources: apps");
  t.equal(map.controls, true, "macOS controls are on now that volume and power exist");
  await mac.featureState({ installed: [], running: [{ bundleId: "com.spotify.client", pid: 700 }] });
  t.equal(rec.calls.length, 1, "permission checks are cached between 3 s polls");
  const none = await createMacProvider({ exec: macRecorder([]).exec, appDirs: [] }).featureState({ installed: [], running: [] });
  t.deepEqual(none.players, [], "a Mac with neither player installed lists none");
}
{
  // Permission requests and settings.
  const rec = macRecorder([[RUNNING_JXA, "[]"], [PERMISSION_JXA, '{"com.apple.systemevents":0}']]);
  const mac = createMacProvider({ exec: rec.exec, appDirs: [] });
  t.equal(await mac.requestPermission("spotify"), "not-running", "asking for a player that is not running is refused");
  t.ok(!rec.calls.some((c) => c.args[3] === PERMISSION_JXA), "no prompt is attempted for a player that is not running");
  rec.calls.length = 0;
  t.equal(await mac.requestPermission("system-events"), "granted", "a System Events request reports the answer");
  t.deepEqual(rec.calls[0], { file: OPEN, args: ["-g", "-b", "com.apple.systemevents"], options: undefined }, "System Events is started in the background first");
  t.deepEqual(rec.calls[1].args, osascriptArgv(PERMISSION_JXA, ["ask", "com.apple.systemevents"]), "then asked in ask mode");
  t.equal(rec.calls[1].options?.timeout, 60_000, "the prompt is waited on for 60 s");
  await t.rejects(() => mac.requestPermission("finder"), "an unknown scope is refused by the provider too");
  rec.calls.length = 0;
  await mac.openPermissionSettings("music");
  t.deepEqual(rec.calls[0], { file: OPEN, args: [AUTOMATION_SETTINGS_URL], options: undefined }, "open-settings opens the Automation pane");
  t.equal(AUTOMATION_SETTINGS_URL, "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation", "the Automation pane URL");
  const timeout = macRecorder([[RUNNING_JXA, SPOTIFY_RUNNING], [PERMISSION_JXA, new Error("killed")]]);
  t.equal(await createMacProvider({ exec: timeout.exec, appDirs: [] }).requestPermission("spotify"), "needed", "an unanswered prompt (60 s) reports needed");
}
{
  // Volume, power, session argv.
  const rec = macRecorder([
    [VOLUME_GET_AS, "40,false"],
    [VOLUME_SET_AS, (file, args) => `${args[5] || 40},${args[6] || "false"}`],
    [LOCK_JXA, '{"ok":true,"result":0}'],
    [SESSION_JXA, '{"locked":true}'],
    [PERMISSION_JXA, '{"com.apple.systemevents":0}'],
  ]);
  const mac = createMacProvider({ exec: rec.exec, appDirs: [] });
  t.deepEqual(await mac.volume(), { level: 40, muted: false }, "macOS volume read");
  t.deepEqual(rec.calls.at(-1), { file: OSASCRIPT, args: appleScriptArgv(VOLUME_GET_AS), options: undefined }, "volume read argv");
  await mac.setVolume({ level: 55 });
  t.deepEqual(rec.calls.at(-1).args, appleScriptArgv(VOLUME_SET_AS, ["55", ""]), "volume set argv: level, empty mute");
  await mac.setVolume({ muted: true });
  t.deepEqual(rec.calls.at(-1).args, appleScriptArgv(VOLUME_SET_AS, ["", "true"]), "volume mute argv");
  await mac.control("volume-up", null);
  t.deepEqual(rec.calls.at(-1).args, appleScriptArgv(VOLUME_SET_AS, ["46", ""]), "volume-up steps by 6 from the current level");
  await mac.control("mute-toggle", null);
  t.deepEqual(rec.calls.at(-1).args, appleScriptArgv(VOLUME_SET_AS, ["", "true"]), "mute-toggle flips the current mute");
  rec.calls.length = 0;
  await mac.control("sleep", null);
  t.deepEqual(rec.calls, [{ file: PMSET, args: ["sleepnow"], options: undefined }], "sleep is pmset sleepnow, nothing else");
  rec.calls.length = 0;
  await mac.control("lock", null);
  t.deepEqual(rec.calls.map((c) => [c.file, c.args]), [[OSASCRIPT, osascriptArgv(LOCK_JXA)]], "lock uses the lock script (no pmset when it works)");
  rec.calls.length = 0;
  await mac.control("shutdown", null);
  t.deepEqual(rec.calls[0].args, appleScriptArgv(POWER_AS, ["shutdown"]), "shutdown argv: the verb as argv");
  t.ok(rec.calls[0].options?.timeout >= 60_000, "shutdown may wait for the permission prompt");
  await mac.control("restart", null);
  t.deepEqual(rec.calls[1].args, appleScriptArgv(POWER_AS, ["restart"]), "restart argv");
  t.deepEqual(await mac.sessionState(), { locked: true }, "session.locked from CGSession");
  t.equal(await mac.powerStatus("lock"), "ready", "lock needs no permission");
  t.equal(await mac.powerStatus("shutdown"), "ready", "shutdown is ready once System Events is allowed");

  const noLock = macRecorder([[LOCK_JXA, '{"ok":false}']]);
  await createMacProvider({ exec: noLock.exec, appDirs: [] }).control("lock", null);
  t.deepEqual(noLock.calls.map((c) => [c.file, c.args]), [[OSASCRIPT, osascriptArgv(LOCK_JXA)], [PMSET, ["displaysleepnow"]]], "without the lock call, lock falls back to pmset displaysleepnow");

  const deniedErr = Object.assign(new Error("Command failed"), { stderr: "execution error: Not authorized to send Apple events to System Events. (-1743)" });
  const denied = macRecorder([[POWER_AS, deniedErr]]);
  let error = null;
  try { await createMacProvider({ exec: denied.exec, appDirs: [] }).control("shutdown", null); } catch (e) { error = e; }
  t.deepEqual([error?.status, error?.body], [409, { error: "permission needed", scope: "system-events", status: "denied" }], "-1743 on shutdown maps to 409 denied");

  const seDown = macRecorder([[PERMISSION_JXA, (file, args) => (args[5] === "check" ? '{"com.apple.systemevents":-600}' : '{"com.apple.systemevents":-1744}')]]);
  t.equal(await createMacProvider({ exec: seDown.exec, appDirs: [] }).powerStatus("restart"), "needs-permission", "System Events not running: started, then checked without a prompt");
  t.deepEqual(seDown.calls.map((c) => c.args[5] ?? c.args[0]), ["check", "-g", "wait-check"], "check, start System Events in the background, wait-check (never ask)");
}
{
  // Artwork: Spotify fetched by the host and resized with sips; Music via raw data.
  const fetched = [];
  const big = jpeg(640, 640);
  let spotifyNow = spotifyRow();
  const rec = macRecorder([
    [RUNNING_JXA, BOTH_RUNNING],
    [SPOTIFY_STATE_JXA, () => spotifyNow],
    [MUSIC_STATE_JXA, JSON.stringify({ running: true, permission: 0, state: "paused", name: "S", persistentId: "ABCDEF0123456789", artworkCount: 1, duration: 10, position: 0, shuffle: false, repeat: "off" })],
    [PERMISSION_JXA, '{"com.apple.Music":0}'],
    [(file) => file === SIPS, async (file, args) => { await writeFile(args.at(-1), jpeg(512, 512)); return ""; }],
    [MUSIC_ARTWORK_AS, async (file, args) => { await writeFile(args[5], png(300, 300)); return "ok"; }],
  ]);
  const mac = createMacProvider({
    exec: rec.exec,
    appDirs: [],
    fetchImpl: async (url, init) => { fetched.push(url); return { ok: true, headers: { get: () => String(big.length) }, arrayBuffer: async () => big }; },
  });
  const state = normalizeMediaState(await mac.media());
  const spotifyKey = state.artwork.split("=")[1];
  const art = await mac.mediaArtwork(spotifyKey);
  t.deepEqual(fetched, ["https://i.scdn.co/image/ab67"], "Spotify artwork is fetched by the host from i.scdn.co");
  const sips = rec.calls.find((c) => c.file === SIPS);
  t.deepEqual(sips?.args.slice(0, 4), ["-s", "format", "jpeg", "-Z"], "large artwork is resized with sips");
  t.equal(sips?.args[4], "512", "sips caps the larger edge at 512 px");
  t.deepEqual([art?.mime, imageInfo(art?.bytes)?.width], ["image/jpeg", 512], "the served artwork is at most 512 px");
  t.equal(await mac.mediaArtwork("f".repeat(32)), null, "an unknown key yields no artwork");
  const musicKey = artworkKey("music", "ABCDEF0123456789");
  spotifyNow = spotifyRow({ state: "stopped" });
  t.equal(normalizeMediaState(await mac.media()).artwork, mediaArtworkPath(musicKey), "Music (paused, Spotify stopped) is the source");
  rec.calls.length = 0;
  const musicArt = await mac.mediaArtwork(musicKey);
  t.deepEqual([musicArt?.mime, imageInfo(musicArt?.bytes)?.width], ["image/png", 300], "Music artwork comes from raw data, small ones as is");
  const order = rec.calls.map((c) => c.args[3] ?? c.file);
  t.ok(order.indexOf(RUNNING_JXA) < order.indexOf(PERMISSION_JXA) && order.indexOf(PERMISSION_JXA) < order.indexOf(MUSIC_ARTWORK_AS), "Music artwork: running check, permission check, then the script");
  const artCall = rec.calls.find((c) => c.args[3] === MUSIC_ARTWORK_AS);
  t.equal(artCall.args[6], "ABCDEF0123456789", "the persistent ID is passed as argv");
  t.ok(artCall.args[5].startsWith(tmpdir()), "artwork is written to a private temp file");
  t.ok(!rec.calls.some((c) => c.file === SIPS), "artwork at or under 512 px is not resized");
}

await rm(dir, { recursive: true, force: true });
t.done("dock-controls verification passed");
