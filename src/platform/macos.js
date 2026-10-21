/**
 * macOS platform provider (V1: catalog, icons, running apps, launch, focus,
 * polite close).
 *
 * The design mirrors the Windows provider:
 *
 *  - Every native query runs a CONSTANT JXA script (`osascript -l JavaScript`).
 *    No caller data is ever interpolated into script text; data reaches the
 *    script only through `run(argv)`, passed as separate argv entries after a
 *    `--` separator so a value can never be read as an osascript option.
 *
 *  - Launch goes through `/usr/bin/open` with a validated bundle identifier or
 *    an absolute `.app` path, again as an argv array.
 *
 * All OS work goes through the injected `exec(file, args)`, so this file stays
 * pure and its argv is assertable in tests on any OS.
 *
 * Dock controls (DOCK-CONTROLS.md): Spotify and Music through their own
 * scripting dictionaries, system volume through Standard Additions, power
 * through pmset, a private-but-stable lock call and System Events. Every
 * player script checks that the player is running and that the Automation
 * permission is already granted before it sends the player a single Apple
 * event, so reading media never launches a player and never shows a prompt.
 * Only `requestPermission` asks, and only when the phone asked it to.
 *
 * Capture and touchpad are out of scope on macOS.
 */

import { homedir, totalmem, freemem, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { CONTROL_VERBS, PERMISSION_WAIT_MS, REPEAT_MODES, hostError, mediaArtworkPath, nowPlayingFromMedia, validateControl } from "./contract.js";
import { ARTWORK_KEEP_PX, ARTWORK_MAX_BYTES, ARTWORK_MAX_PX, artworkKey, fetchSpotifyArtwork, imageInfo, spotifyArtworkUrl } from "./artwork.js";

export const OSASCRIPT = "/usr/bin/osascript";
export const OPEN = "/usr/bin/open";
export const PMSET = "/usr/bin/pmset";
export const SIPS = "/usr/bin/sips";
/** `--` ends osascript's own option parsing; everything after it is argv. */
export const OSASCRIPT_FLAGS = Object.freeze(["-l", "JavaScript", "-e"]);

export const ICON_SIZE = 256;
export const ICON_MAX_BYTES = 512 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Default scan order. Earlier directories win when the same app appears twice. */
export function defaultAppDirs(home = homedir()) {
  return [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    join(home, "Applications"),
  ];
}

/**
 * Constant JXA: list `.app` bundles in each argv directory, plus `.app`
 * bundles one level down in plain (non-.app) subfolders. Never descends into a
 * bundle. Unreadable directories yield nothing. Emits a JSON array of
 * `{ bundleId, name, path, backgroundOnly }`. Menu-bar (LSUIElement) apps are
 * reported like any other app; only LSBackgroundOnly apps are flagged.
 */
export const INVENTORY_JXA = [
  "function run(argv) {",
  "  ObjC.import('Foundation');",
  "  var fm = $.NSFileManager.defaultManager;",
  "  var out = [];",
  "  function str(v) { try { if (!v || v.isNil()) return null; var s = ObjC.unwrap(v); return typeof s === 'string' ? s : null; } catch (e) { return null; } }",
  "  function truthy(v) { try { if (!v || v.isNil()) return false; var u = ObjC.unwrap(v); return u === true || u === 1 || u === '1' || u === 'YES' || u === 'true'; } catch (e) { return false; } }",
  "  function list(dir) { try { var items = fm.contentsOfDirectoryAtPathError(dir, null); if (!items || items.isNil()) return []; var names = ObjC.deepUnwrap(items); return Array.isArray(names) ? names.sort() : []; } catch (e) { return []; } }",
  "  function isDir(p) { var d = Ref(); return fm.fileExistsAtPathIsDirectory(p, d) && d[0] === true; }",
  "  function isApp(n) { return n.charAt(0) !== '.' && /\\.app$/i.test(n); }",
  "  function emit(p) {",
  "    try {",
  "      var b = $.NSBundle.bundleWithPath(p);",
  "      var has = b && !b.isNil();",
  "      var info = has ? b.infoDictionary : null;",
  "      var name = str(fm.displayNameAtPath(p)) || '';",
  "      if (/\\.app$/i.test(name)) name = name.slice(0, -4);",
  "      var backgroundOnly = info && !info.isNil() ? truthy(info.objectForKey('LSBackgroundOnly')) : false;",
  "      out.push({ bundleId: has ? str(b.bundleIdentifier) : null, name: name, path: p, backgroundOnly: backgroundOnly });",
  "    } catch (e) {}",
  "  }",
  "  for (var i = 0; i < argv.length; i++) {",
  "    var dir = String(argv[i]).replace(/\\/+$/, '');",
  "    var names = list(dir);",
  "    for (var j = 0; j < names.length; j++) {",
  "      var n = names[j];",
  "      if (n.charAt(0) === '.') continue;",
  "      var p = dir + '/' + n;",
  "      if (isApp(n)) { emit(p); continue; }",
  "      if (/\\.app$/i.test(n) || !isDir(p)) continue;",
  "      var sub = list(p);",
  "      for (var k = 0; k < sub.length; k++) { if (isApp(sub[k])) emit(p + '/' + sub[k]); }",
  "    }",
  "  }",
  "  return JSON.stringify(out);",
  "}",
].join("\n");

/**
 * Constant JXA: draw the Finder icon for argv[0] into an explicit 256x256
 * bitmap and emit it as base64 PNG (empty output when there is no icon).
 * Drawing into a fixed-size rep keeps the payload small; the multi-rep
 * TIFFRepresentation would be around 1 MB.
 */
export const ICON_JXA = [
  "function run(argv) {",
  "  ObjC.import('AppKit');",
  "  var size = 256;",
  "  var icon = $.NSWorkspace.sharedWorkspace.iconForFile(String(argv[0]));",
  "  if (!icon || icon.isNil()) return '';",
  "  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, 'NSDeviceRGBColorSpace', 0, 0);",
  "  if (!rep || rep.isNil()) return '';",
  "  rep.setSize($.NSMakeSize(size, size));",
  "  var ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);",
  "  if (!ctx || ctx.isNil()) return '';",
  "  $.NSGraphicsContext.saveGraphicsState;",
  "  $.NSGraphicsContext.setCurrentContext(ctx);",
  "  ctx.setImageInterpolation(3);",
  "  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, 2, 1.0);",
  "  ctx.flushGraphics;",
  "  $.NSGraphicsContext.restoreGraphicsState;",
  "  var png = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);",
  "  if (!png || png.isNil()) return '';",
  "  return ObjC.unwrap(png.base64EncodedStringWithOptions(0));",
  "}",
].join("\n");

/** Constant JXA: regular (Dock-visible) running applications as JSON. */
export const RUNNING_JXA = [
  "function run(argv) {",
  "  ObjC.import('AppKit');",
  "  function str(v) { try { if (!v || v.isNil()) return null; var s = ObjC.unwrap(v); return typeof s === 'string' ? s : null; } catch (e) { return null; } }",
  "  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;",
  "  var out = [];",
  "  for (var i = 0; i < apps.count; i++) {",
  "    var a = apps.objectAtIndex(i);",
  "    if (Number(a.activationPolicy) !== 0) continue;",
  "    var url = a.bundleURL;",
  "    out.push({ pid: Number(a.processIdentifier), name: str(a.localizedName) || '', bundleId: str(a.bundleIdentifier), path: url && !url.isNil() ? str(url.path) : null });",
  "  }",
  "  return JSON.stringify(out);",
  "}",
].join("\n");

/** Constant JXA: bring every window of the app with pid argv[0] forward. */
export const FOCUS_JXA = [
  "function run(argv) {",
  "  ObjC.import('AppKit');",
  "  var pid = parseInt(argv[0], 10);",
  "  if (!(pid > 0)) throw new Error('invalid pid');",
  "  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);",
  "  if (!app || app.isNil()) throw new Error('no running application for pid');",
  "  return JSON.stringify({ ok: true, activated: app.activateWithOptions(1) === true });",
  "}",
].join("\n");

/**
 * Constant JXA: politely ask the app with pid argv[0] to quit. The app may
 * prompt to save, exactly like WM_CLOSE on Windows. Never force-terminates.
 */
export const CLOSE_JXA = [
  "function run(argv) {",
  "  ObjC.import('AppKit');",
  "  var pid = parseInt(argv[0], 10);",
  "  if (!(pid > 0)) throw new Error('invalid pid');",
  "  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);",
  "  if (!app || app.isNil()) throw new Error('no running application for pid');",
  "  return JSON.stringify({ ok: true, terminated: app.terminate === true });",
  "}",
].join("\n");

/** Argv for running a constant script with data passed only as argv. */
export function osascriptArgv(script, args = []) {
  return [...OSASCRIPT_FLAGS, script, "--", ...args];
}

/** Same, for a constant AppleScript (Standard Additions, `raw data`, System Events). */
export function appleScriptArgv(script, args = []) {
  return ["-l", "AppleScript", "-e", script, "--", ...args];
}

// ---- dock controls: players, permissions, volume, power, session ----------

export const SPOTIFY_ID = "com.spotify.client";
export const MUSIC_ID = "com.apple.Music";
export const SYSTEM_EVENTS_ID = "com.apple.systemevents";
/** The players macOS can read and control (DOCK-CONTROLS 5.4), in preference order. */
export const MAC_PLAYERS = Object.freeze([
  Object.freeze({ id: "spotify", name: "Spotify", appId: SPOTIFY_ID }),
  Object.freeze({ id: "music", name: "Music", appId: MUSIC_ID }),
]);
/** Phone-facing permission scope to the Automation target it names. */
export const PERMISSION_TARGETS = Object.freeze({ spotify: SPOTIFY_ID, music: MUSIC_ID, "system-events": SYSTEM_EVENTS_ID });
/** System Settings › Privacy & Security › Automation. */
export const AUTOMATION_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";
/** What the macOS host maps (brightness needs private display APIs; not offered). */
export const MAC_CONTROL_VERBS = Object.freeze(CONTROL_VERBS.filter((v) => v !== "brightness-set"));
/** One keyboard volume step on a Mac is 1/16 of the range. */
export const VOLUME_STEP = 6;
const PLAYER_READ_TIMEOUT_MS = 5_000;
const POWER_TIMEOUT_MS = 120_000;
const PERMISSION_CACHE_MS = 5_000;

/**
 * Shared JXA prelude: `permission(id)` asks the system, without prompting,
 * whether this process may send Apple events to the app. 0 granted, -1744
 * would need consent, -1743 denied, -600 not running.
 */
const PERMISSION_FN = [
  "  ObjC.import('Foundation');",
  "  ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void*', 'unsigned int', 'unsigned int', 'bool']]);",
  "  function permission(id, ask) {",
  "    var desc = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(id);",
  "    return $.AEDeterminePermissionToAutomateTarget(desc.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, ask === true);",
  "  }",
  "  function get(f) { try { var v = f(); return v === undefined ? null : v; } catch (e) { return null; } }",
];

/**
 * Constant JXA: Automation permission for allowlisted targets. argv[0] is the
 * mode: "check" (never prompts), "wait-check" (waits up to 3 s for the target
 * to be running, never prompts) or "ask" (waits, then shows the consent
 * prompt and blocks until it is answered). Never launches anything.
 */
export const PERMISSION_JXA = [
  "function run(argv) {",
  ...PERMISSION_FN,
  "  var mode = String(argv[0]);",
  "  if (mode !== 'check' && mode !== 'wait-check' && mode !== 'ask') throw new Error('invalid mode');",
  "  var allowed = ['com.spotify.client', 'com.apple.Music', 'com.apple.systemevents'];",
  "  var out = {};",
  "  for (var i = 1; i < argv.length; i++) {",
  "    var id = String(argv[i]);",
  "    if (allowed.indexOf(id) < 0) continue;",
  "    if (mode !== 'check') { var app = Application(id); for (var k = 0; k < 30 && !app.running(); k++) delay(0.1); }",
  "    out[id] = permission(id, mode === 'ask');",
  "  }",
  "  return JSON.stringify(out);",
  "}",
].join("\n");

/** JXA guard shared by every player script: running and allowed, or return why not. */
function playerGuard(id) {
  return [
    "  var app = Application('" + id + "');",
    "  if (!app.running()) return JSON.stringify({ running: false });",
    "  var code = permission('" + id + "', false);",
    "  if (code !== 0) return JSON.stringify({ running: true, permission: code });",
  ];
}

/** Constant JXA: Spotify's player state and current track. No argv. */
export const SPOTIFY_STATE_JXA = [
  "function run(argv) {",
  ...PERMISSION_FN,
  ...playerGuard(SPOTIFY_ID),
  "  var t = app.currentTrack;",
  "  return JSON.stringify({",
  "    running: true, permission: 0,",
  "    state: get(function () { return String(app.playerState()); }),",
  "    name: get(function () { return t.name(); }),",
  "    artist: get(function () { return t.artist(); }),",
  "    album: get(function () { return t.album(); }),",
  "    durationMs: get(function () { return t.duration(); }),",
  "    trackId: get(function () { return t.id(); }),",
  "    artworkUrl: get(function () { return t.artworkUrl(); }),",
  "    position: get(function () { return app.playerPosition(); }),",
  "    shuffle: get(function () { return app.shuffling(); }),",
  "    repeat: get(function () { return app.repeating(); })",
  "  });",
  "}",
].join("\n");

/** Constant JXA: one Spotify command. argv: [action, value]. */
export const SPOTIFY_COMMAND_JXA = [
  "function run(argv) {",
  ...PERMISSION_FN,
  "  var action = String(argv[0]);",
  "  var value = argv.length > 1 ? String(argv[1]) : '';",
  ...playerGuard(SPOTIFY_ID),
  "  if (action === 'toggle') app.playpause();",
  "  else if (action === 'play') app.play();",
  "  else if (action === 'pause') app.pause();",
  "  else if (action === 'next') app.nextTrack();",
  "  else if (action === 'previous') app.previousTrack();",
  "  else if (action === 'seek') { var ms = parseInt(value, 10); if (!(ms >= 0)) throw new Error('invalid position'); app.playerPosition = ms / 1000; }",
  "  else if (action === 'shuffle') app.shuffling = value === 'true';",
  "  else if (action === 'repeat') app.repeating = value !== 'off';",
  "  else throw new Error('unknown action');",
  "  return JSON.stringify({ running: true, permission: 0, ok: true });",
  "}",
].join("\n");

/** Constant JXA: Music's player state and current track. No argv. */
export const MUSIC_STATE_JXA = [
  "function run(argv) {",
  ...PERMISSION_FN,
  ...playerGuard(MUSIC_ID),
  "  var t = app.currentTrack;",
  "  return JSON.stringify({",
  "    running: true, permission: 0,",
  "    state: get(function () { return String(app.playerState()); }),",
  "    name: get(function () { return t.name(); }),",
  "    artist: get(function () { return t.artist(); }),",
  "    album: get(function () { return t.album(); }),",
  "    duration: get(function () { return t.duration(); }),",
  "    persistentId: get(function () { return t.persistentID(); }),",
  "    artworkCount: get(function () { return t.artworks.length; }),",
  "    position: get(function () { return app.playerPosition(); }),",
  "    shuffle: get(function () { return app.shuffleEnabled(); }),",
  "    repeat: get(function () { return String(app.songRepeat()); })",
  "  });",
  "}",
].join("\n");

/** Constant JXA: one Music command. argv: [action, value]. */
export const MUSIC_COMMAND_JXA = [
  "function run(argv) {",
  ...PERMISSION_FN,
  "  var action = String(argv[0]);",
  "  var value = argv.length > 1 ? String(argv[1]) : '';",
  ...playerGuard(MUSIC_ID),
  "  if (action === 'toggle') app.playpause();",
  "  else if (action === 'play') app.play();",
  "  else if (action === 'pause') app.pause();",
  "  else if (action === 'next') app.nextTrack();",
  "  else if (action === 'previous') app.previousTrack();",
  "  else if (action === 'seek') { var ms = parseInt(value, 10); if (!(ms >= 0)) throw new Error('invalid position'); app.playerPosition = ms / 1000; }",
  "  else if (action === 'shuffle') app.shuffleEnabled = value === 'true';",
  "  else if (action === 'repeat') { if (['off', 'one', 'all'].indexOf(value) < 0) throw new Error('invalid repeat'); app.songRepeat = value; }",
  "  else throw new Error('unknown action');",
  "  return JSON.stringify({ running: true, permission: 0, ok: true });",
  "}",
].join("\n");

/**
 * Constant AppleScript: write the current Music track's first artwork
 * (`raw data`) to the file argv[0], if the current track is still argv[1].
 * Returns "ok", "none", "changed" or "not-running". The running check comes
 * before the tell block, so a quit Music is never launched.
 */
export const MUSIC_ARTWORK_AS = [
  "on run argv",
  "  set outPath to item 1 of argv",
  "  set wantId to item 2 of argv",
  '  if application id "com.apple.Music" is not running then return "not-running"',
  '  tell application id "com.apple.Music"',
  "    try",
  "      set t to current track",
  "    on error",
  '      return "none"',
  "    end try",
  '    if (persistent ID of t) is not wantId then return "changed"',
  '    if (count of artworks of t) is 0 then return "none"',
  "    set d to raw data of artwork 1 of t",
  "  end tell",
  "  set f to open for access (POSIX file outPath) with write permission",
  "  try",
  "    set eof f to 0",
  "    write d to f",
  "    close access f",
  "  on error e",
  "    close access f",
  "    error e",
  "  end try",
  '  return "ok"',
  "end run",
].join("\n");

/** Constant AppleScript: system output volume and mute, as "level,muted". */
export const VOLUME_GET_AS = [
  "on run argv",
  "  set s to get volume settings",
  '  return (output volume of s as text) & "," & (output muted of s as text)',
  "end run",
].join("\n");

/**
 * Constant AppleScript: argv[0] is a level 0..100 or "", argv[1] "true",
 * "false" or "". Returns the new "level,muted".
 */
export const VOLUME_SET_AS = [
  "on run argv",
  "  set lvl to item 1 of argv",
  "  set m to item 2 of argv",
  '  if lvl is not "" then set volume output volume (lvl as integer)',
  '  if m is "true" then set volume output muted true',
  '  if m is "false" then set volume output muted false',
  "  set s to get volume settings",
  '  return (output volume of s as text) & "," & (output muted of s as text)',
  "end run",
].join("\n");

/**
 * Constant AppleScript: shut down or restart through System Events (needs
 * the one-time Automation permission). Apps may still cancel it.
 */
export const POWER_AS = [
  "on run argv",
  "  set verb to item 1 of argv",
  "  with timeout of 110 seconds",
  '    if verb is "shutdown" then',
  '      tell application id "com.apple.systemevents" to shut down',
  '    else if verb is "restart" then',
  '      tell application id "com.apple.systemevents" to restart',
  "    else",
  '      error "invalid verb"',
  "    end if",
  "  end timeout",
  '  return "ok"',
  "end run",
].join("\n");

/**
 * Constant JXA: lock the screen now. SACLockScreenImmediate (login.framework)
 * is what the menu-bar "Lock Screen" item calls: it needs no admin rights and
 * no Accessibility permission, and locks whatever the "require password"
 * delay is. It is private, so a missing symbol returns { ok: false } and the
 * provider falls back to `pmset displaysleepnow`.
 */
export const LOCK_JXA = [
  "function run(argv) {",
  "  ObjC.import('Foundation');",
  "  var b = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/login.framework');",
  "  if (!b || b.isNil() || !b.load) return JSON.stringify({ ok: false });",
  "  try { ObjC.bindFunction('SACLockScreenImmediate', ['int', []]); } catch (e) { return JSON.stringify({ ok: false }); }",
  "  return JSON.stringify({ ok: true, result: $.SACLockScreenImmediate() });",
  "}",
].join("\n");

/** Constant JXA: is the login session's screen locked (CGSessionCopyCurrentDictionary)? */
export const SESSION_JXA = [
  "function run(argv) {",
  "  ObjC.import('CoreGraphics');",
  "  ObjC.import('Foundation');",
  "  var ref = $.CGSessionCopyCurrentDictionary();",
  "  if (!ref) return JSON.stringify({ locked: null });",
  "  var d = ObjC.castRefToObject(ref);",
  "  var v = d.objectForKey('CGSSessionScreenIsLocked');",
  "  return JSON.stringify({ locked: Boolean(v && !v.isNil() && v.boolValue) });",
  "}",
].join("\n");

/** Map an AEDeterminePermissionToAutomateTarget result to a status. */
export function permissionFromCode(code) {
  if (code === 0) return "granted";
  if (code === -1743) return "denied";
  if (code === -600) return "not-running";
  return "needed";
}

/** Parse "level,muted" from the volume scripts. */
export function parseVolume(raw) {
  const [lvl, muted] = String(raw || "").trim().split(",");
  const level = /^\d{1,3}$/.test(lvl ?? "") ? Math.min(100, Number(lvl)) : null;
  return { level, muted: muted === "true" ? true : muted === "false" ? false : null };
}

/** Bundle ids a phone must never be offered to close (5.1). */
export const MAC_NOT_CLOSABLE = Object.freeze([
  "com.apple.finder",
  "com.apple.loginwindow",
  "com.apple.dock",
  "com.apple.systemuiserver",
  "com.apple.controlcenter",
  "com.apple.notificationcenterui",
  "dev.gerikotori.windock.menu",
]);

/** Whether a running macOS app may be closed from the dock. */
export function macClosable(entry) {
  const id = typeof entry?.bundleId === "string" ? entry.bundleId.toLowerCase() : "";
  return !MAC_NOT_CLOSABLE.includes(id);
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** A bundle identifier we will pass to `open -b`, or null. Cannot start with `-`. */
export function validBundleId(value) {
  return typeof value === "string" && BUNDLE_ID.test(value) ? value : null;
}

/** An absolute path to a `.app` bundle, or null. */
export function validAppPath(value) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || !/\.app$/i.test(value)) return null;
  if (/[\0\r\n]/.test(value)) return null;
  if (value.split("/").includes("..")) return null;
  return value;
}

/** Stable app id shared by inventory and running apps. */
export function macAppId(bundleId, path) {
  const id = validBundleId(bundleId);
  if (id) return id;
  return typeof path === "string" && path.startsWith("/") ? `path:${path.toLowerCase()}` : null;
}

function jsonArray(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Parse inventory JSON into deduplicated, sorted app records. */
export function parseInventory(raw) {
  const byId = new Map();
  for (const row of jsonArray(raw)) {
    // Faceless background apps cannot be launched into anything useful.
    // Menu-bar (LSUIElement) apps stay: users launch them from the dock.
    if (!row || typeof row !== "object" || row.backgroundOnly === true) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const path = validAppPath(typeof row.path === "string" ? row.path.trim() : "");
    if (!name || !path) continue;
    const bundleId = validBundleId(row.bundleId);
    const id = macAppId(bundleId, path);
    // First directory in scan order wins (e.g. /Applications over ~/Applications).
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, name, target: path, args: "", icon: "", source: "bundle", bundleId });
  }
  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
}

/** Parse running-app JSON into identities whose ids match inventory ids. */
export function parseRunning(raw) {
  const out = [];
  const seen = new Set();
  for (const row of jsonArray(raw)) {
    if (!row || typeof row !== "object") continue;
    const pid = Number(row.pid);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const path = typeof row.path === "string" && row.path.startsWith("/") ? row.path : "";
    const bundleId = validBundleId(row.bundleId);
    const id = macAppId(bundleId, path) || (name ? `proc:${name.toLowerCase()}` : null);
    if (!id) continue;
    seen.add(pid);
    out.push({ id, name, title: "", pid, handle: 0, path, bundleId });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Decode an icon payload, rejecting oversized or non-PNG data. */
export function decodeIcon(stdout) {
  const text = String(stdout || "").trim();
  if (!text || text.length > Math.ceil(ICON_MAX_BYTES / 3) * 4 + 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > ICON_MAX_BYTES) return null;
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? bytes : null;
}

/** argv for `open`, from validated values only. Throws when neither is valid. */
export function launchArgv(app) {
  const bundleId = validBundleId(app?.bundleId);
  if (bundleId) return ["-b", bundleId];
  const target = validAppPath(app?.target);
  if (target) return [target];
  throw new Error("launchApp requires a valid bundle identifier or an absolute .app path");
}

function requirePid(running, method) {
  const pid = Number(running?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${method} requires a positive integer pid`);
  }
  return pid;
}

const PERSISTENT_ID = /^[A-F0-9]{16}$/;

function jsonObject(raw) {
  try {
    const parsed = JSON.parse(String(raw || "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Create the macOS provider.
 * @param {object} opts
 * @param {(file:string,args:string[],options?:{timeout?:number})=>Promise<{stdout:string}>} opts.exec
 * @param {string[]} [opts.appDirs] directories to scan, in priority order
 * @param {string} [opts.osascript] osascript binary (absolute path)
 * @param {() => number} [opts.now] clock (tests)
 * @param {typeof fetch} [opts.fetchImpl] used only for allowlisted Spotify artwork
 */
export function createMacProvider({ exec, appDirs = defaultAppDirs(), osascript = OSASCRIPT, now = Date.now, fetchImpl = globalThis.fetch } = {}) {
  if (typeof exec !== "function") throw new Error("macos provider requires exec");
  const dirs = Object.freeze([...appDirs].filter((d) => typeof d === "string" && d.startsWith("/")));
  const jxa = (script, args = [], options) => exec(osascript, osascriptArgv(script, args), ...(options ? [options] : []));
  const applescript = (script, args = [], options) => exec(osascript, appleScriptArgv(script, args), ...(options ? [options] : []));

  // Automation permission: the last answer per target, and when it was read.
  const permissions = new Map(); // bundle id -> { status, at }
  const lastKnown = new Map(); // bundle id -> "granted" | "needed" | "denied"
  const lastPlayingAt = new Map(); // player id -> ms
  const artworkKeys = new Map(); // key -> { kind: "url", url } | { kind: "music", persistentId }
  let tempDir = null;

  function remember(id, status) {
    permissions.set(id, { status, at: now() });
    if (status !== "not-running") lastKnown.set(id, status);
  }
  async function checkPermissions(ids, mode = "check", options) {
    const out = {};
    if (!ids.length) return out;
    try {
      const { stdout } = await jxa(PERMISSION_JXA, [mode, ...ids], options);
      const codes = jsonObject(stdout) || {};
      for (const id of ids) {
        if (typeof codes[id] !== "number") continue;
        out[id] = permissionFromCode(codes[id]);
        remember(id, out[id]);
      }
    } catch {
      /* unknown: callers fall back to the last known answer */
    }
    return out;
  }
  /** Cached (5 s) no-prompt check, for the capability map polled every 3 s. */
  async function cachedPermissions(ids) {
    const stale = ids.filter((id) => {
      const hit = permissions.get(id);
      return !hit || now() - hit.at > PERMISSION_CACHE_MS;
    });
    await checkPermissions(stale);
    return Object.fromEntries(ids.map((id) => [id, permissions.get(id)?.status ?? null]));
  }
  const powerFromPermission = (status) => {
    const known = status === "not-running" || !status ? lastKnown.get(SYSTEM_EVENTS_ID) : status;
    return known === "granted" ? "ready" : known === "denied" ? "denied" : "needs-permission";
  };

  async function runningApps() {
    const { stdout } = await jxa(RUNNING_JXA);
    return parseRunning(stdout).map((entry) => ({ ...entry, closable: macClosable(entry) }));
  }

  function rememberArtwork(key, descriptor) {
    artworkKeys.delete(key);
    artworkKeys.set(key, descriptor);
    while (artworkKeys.size > 64) artworkKeys.delete(artworkKeys.keys().next().value);
    return mediaArtworkPath(key);
  }

  /**
   * Read every RUNNING supported player. The running list comes first: a
   * player that is not running is never sent a script (and each script checks
   * again, and checks the permission, before its first Apple event).
   */
  async function readPlayers() {
    const running = await runningApps();
    const runningIds = new Set(running.map((r) => r.bundleId).filter(Boolean));
    const reads = [];
    const blocked = [];
    for (const player of MAC_PLAYERS) {
      if (!runningIds.has(player.appId)) continue;
      const script = player.id === "spotify" ? SPOTIFY_STATE_JXA : MUSIC_STATE_JXA;
      let row = null;
      try {
        row = jsonObject((await jxa(script, [], { timeout: PLAYER_READ_TIMEOUT_MS })).stdout);
      } catch {
        row = null;
      }
      if (!row || row.running !== true) continue;
      if (row.permission !== 0) {
        const status = permissionFromCode(row.permission);
        remember(player.appId, status);
        if (status === "needed" || status === "denied") blocked.push({ player: player.id, status });
        continue;
      }
      remember(player.appId, "granted");
      const state = String(row.state || "").toLowerCase();
      const playing = state === "playing" || state === "fast forwarding" || state === "rewinding";
      if (playing) lastPlayingAt.set(player.id, now());
      reads.push({ player, row, playing, paused: state === "paused" });
    }
    return { reads, blocked };
  }

  /** Active source: the playing player, else the most recently paused running one. */
  function chooseActive(reads) {
    const playing = reads.find((r) => r.playing);
    if (playing) return playing;
    const paused = reads.filter((r) => r.paused);
    paused.sort((a, b) => (lastPlayingAt.get(b.player.id) || 0) - (lastPlayingAt.get(a.player.id) || 0));
    return paused[0] || null;
  }

  function stateFor(read) {
    const { player, row } = read;
    const spotify = player.id === "spotify";
    const durationMs = spotify ? finiteOrNull(row.durationMs) : finiteOrNull(row.duration) === null ? null : row.duration * 1000;
    const position = finiteOrNull(row.position);
    let artwork = null;
    if (spotify) {
      const url = spotifyArtworkUrl(row.artworkUrl);
      if (url) artwork = rememberArtwork(artworkKey("spotify", url), { kind: "url", url });
    } else if (typeof row.persistentId === "string" && PERSISTENT_ID.test(row.persistentId) && Number(row.artworkCount) > 0) {
      artwork = rememberArtwork(artworkKey("music", row.persistentId), { kind: "music", persistentId: row.persistentId });
    }
    const repeat = spotify
      ? (typeof row.repeat === "boolean" ? (row.repeat ? "all" : "off") : null)
      : (REPEAT_MODES.includes(row.repeat) ? row.repeat : null);
    const shuffle = typeof row.shuffle === "boolean" ? row.shuffle : null;
    return {
      source: { id: player.id, name: player.name, appId: player.appId, sessionId: null },
      title: row.name,
      artist: row.artist,
      album: row.album,
      playing: read.playing,
      positionMs: position === null ? null : Math.round(position * 1000),
      durationMs: durationMs === null ? null : Math.round(durationMs),
      updatedAt: now(),
      artwork,
      controls: { previous: true, next: true, playPause: true, seek: Boolean(durationMs > 0), shuffle: shuffle !== null, repeat: repeat !== null },
      shuffle,
      repeat,
      // Spotify's dictionary only has a repeating flag, so "one" is not offered.
      repeatModes: spotify ? ["off", "all"] : ["off", "all", "one"],
      sessions: [],
      permission: null,
    };
  }

  async function media() {
    const { reads, blocked } = await readPlayers();
    const active = chooseActive(reads);
    if (active) return stateFor(active);
    return {
      source: null,
      updatedAt: now(),
      // A running, allowed but stopped player can still be started.
      controls: { previous: false, next: false, playPause: reads.length > 0, seek: false, shuffle: false, repeat: false },
      sessions: [],
      permission: blocked[0] || null,
    };
  }

  async function mediaCommand(action, value, sessionId) {
    if (!["play", "pause", "toggle", "next", "previous", "seek", "shuffle", "repeat"].includes(action)) {
      throw hostError(501, { error: "action unavailable" });
    }
    const { reads, blocked } = await readPlayers();
    const target = chooseActive(reads) || reads[0] || null;
    if (!target) {
      if (blocked.length) throw hostError(409, { error: "permission needed", player: blocked[0].player, status: blocked[0].status });
      throw hostError(404, { error: "no media session" });
    }
    const arg = action === "seek" ? String(value) : action === "shuffle" ? String(value === true) : action === "repeat" ? String(value) : "";
    const script = target.player.id === "spotify" ? SPOTIFY_COMMAND_JXA : MUSIC_COMMAND_JXA;
    const row = jsonObject((await jxa(script, [action, arg], { timeout: PLAYER_READ_TIMEOUT_MS })).stdout);
    if (!row || row.running !== true) throw hostError(404, { error: "no media session" });
    if (row.permission !== 0) {
      const status = permissionFromCode(row.permission);
      remember(target.player.appId, status);
      throw hostError(409, { error: "permission needed", player: target.player.id, status: status === "denied" ? "denied" : "needed" });
    }
  }

  async function ensureTempDir() {
    if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), "windock-artwork-"));
    return tempDir;
  }

  /** Larger edge at most 512 px: sips for bigger images, the original when it is small enough. */
  async function fitArtwork(bytes) {
    const info = imageInfo(bytes);
    if (!info || bytes.length > ARTWORK_MAX_BYTES) return null;
    const edge = Math.max(info.width, info.height);
    if (edge <= ARTWORK_MAX_PX) return { mime: info.mime, bytes };
    const dir = await ensureTempDir();
    const input = join(dir, `${randomUUID()}.src`);
    const output = join(dir, `${randomUUID()}.jpg`);
    try {
      await writeFile(input, bytes);
      await exec(SIPS, ["-s", "format", "jpeg", "-Z", String(ARTWORK_MAX_PX), input, "--out", output]);
      const resized = await readFile(output);
      const out = imageInfo(resized);
      if (out && Math.max(out.width, out.height) <= ARTWORK_MAX_PX && resized.length <= ARTWORK_MAX_BYTES) {
        return { mime: out.mime, bytes: resized };
      }
    } catch {
      /* fall through */
    } finally {
      await rm(input, { force: true }).catch(() => {});
      await rm(output, { force: true }).catch(() => {});
    }
    return edge <= ARTWORK_KEEP_PX ? { mime: info.mime, bytes } : null;
  }

  async function musicArtwork(persistentId) {
    if (!PERSISTENT_ID.test(persistentId)) return null;
    const running = await runningApps();
    if (!running.some((r) => r.bundleId === MUSIC_ID)) return null;
    const status = (await checkPermissions([MUSIC_ID]))[MUSIC_ID];
    if (status !== "granted") return null;
    const dir = await ensureTempDir();
    const file = join(dir, `${randomUUID()}.art`);
    try {
      const { stdout } = await applescript(MUSIC_ARTWORK_AS, [file, persistentId], { timeout: PLAYER_READ_TIMEOUT_MS });
      if (String(stdout).trim() !== "ok") return null;
      return await readFile(file);
    } catch {
      return null;
    } finally {
      await rm(file, { force: true }).catch(() => {});
    }
  }

  async function volume() {
    const { stdout } = await applescript(VOLUME_GET_AS);
    return parseVolume(stdout);
  }

  async function setVolume({ level, muted } = {}) {
    const lvl = Number.isInteger(level) && level >= 0 && level <= 100 ? String(level) : "";
    const mute = typeof muted === "boolean" ? String(muted) : "";
    if (!lvl && !mute) throw new Error("setVolume needs level or muted");
    const { stdout } = await applescript(VOLUME_SET_AS, [lvl, mute]);
    return parseVolume(stdout);
  }

  async function power(verb) {
    if (verb === "lock") {
      let locked = false;
      try {
        locked = jsonObject((await jxa(LOCK_JXA)).stdout)?.ok === true;
      } catch {
        locked = false;
      }
      // Fallback: display sleep, which locks only when "Require password"
      // is set to "immediately" in Lock Screen settings.
      if (!locked) await exec(PMSET, ["displaysleepnow"]);
      return;
    }
    if (verb === "sleep") {
      await exec(PMSET, ["sleepnow"]);
      return;
    }
    try {
      await applescript(POWER_AS, [verb], { timeout: POWER_TIMEOUT_MS });
      remember(SYSTEM_EVENTS_ID, "granted");
    } catch (err) {
      if (/-1743\b/.test(`${err?.stderr || ""} ${err?.message || ""}`)) {
        remember(SYSTEM_EVENTS_ID, "denied");
        throw hostError(409, { error: "permission needed", scope: "system-events", status: "denied" });
      }
      throw err;
    }
  }

  return {
    id: "macos",
    displayName: "macOS",
    features: Object.freeze({
      controls: true,
      nowPlaying: true,
      close: true,
      media: Object.freeze({ sources: "apps", artwork: true, sessions: false }),
      volume: Object.freeze({ get: true, set: true, mute: true }),
      power: Object.freeze({ lock: "ready", sleep: "ready", restart: "needs-permission", shutdown: "needs-permission" }),
      spotify: Object.freeze({ local: Object.freeze({ nowPlaying: true, transport: true, artwork: true, seek: true, shuffle: true, repeat: true }) }),
    }),
    controlVerbs: MAC_CONTROL_VERBS,

    async appIcon(app) {
      const target = validAppPath(app?.target);
      if (!target) return null;
      try {
        const { stdout } = await jxa(ICON_JXA, [target]);
        return decodeIcon(stdout);
      } catch {
        return null;
      }
    },

    async listInstalledApps() {
      const { stdout } = await jxa(INVENTORY_JXA, [...dirs]);
      return parseInventory(stdout);
    },

    async listRunningApps() {
      return runningApps();
    },

    async launchApp(app) {
      await exec(OPEN, launchArgv(app));
    },

    async focusApp(running) {
      const pid = requirePid(running, "focusApp");
      await jxa(FOCUS_JXA, [String(pid)]);
    },

    async closeApp(running) {
      const pid = requirePid(running, "closeApp");
      await jxa(CLOSE_JXA, [String(pid)]);
    },

    async control(verb, value) {
      const checked = validateControl(verb, value);
      if (!checked.ok) throw new Error(checked.error);
      switch (checked.verb) {
        case "volume-up":
        case "volume-down": {
          const current = await volume();
          if (current.level === null) throw hostError(503, { error: "This sound output has no volume control." });
          const step = checked.verb === "volume-up" ? VOLUME_STEP : -VOLUME_STEP;
          await setVolume({ level: Math.max(0, Math.min(100, current.level + step)) });
          break;
        }
        case "volume-set":
          await setVolume({ level: checked.value });
          break;
        case "mute-toggle": {
          const current = await volume();
          await setVolume({ muted: current.muted !== true });
          break;
        }
        case "media-play-pause": await mediaCommand("toggle", null, null); break;
        case "media-next": await mediaCommand("next", null, null); break;
        case "media-previous": await mediaCommand("previous", null, null); break;
        case "media-stop": await mediaCommand("pause", null, null); break;
        case "lock":
        case "sleep":
        case "shutdown":
        case "restart":
          await power(checked.verb);
          break;
        default:
          throw hostError(501, { error: "This control isn't available on a Mac." });
      }
      return { ok: true, verb: checked.verb };
    },

    async nowPlaying() {
      try {
        return nowPlayingFromMedia(await media());
      } catch {
        return null;
      }
    },

    async systemStats() {
      const total = totalmem();
      const free = freemem();
      const memory = total > 0 ? Math.round(((total - free) / total) * 100) : null;
      return { cpu: null, memory, battery: null, charging: null };
    },

    // ---- dock controls ----

    async featureState({ installed = null, running = [] } = {}) {
      const installedIds = Array.isArray(installed) ? new Set(installed.map((a) => a.id)) : null;
      const runningIds = new Set((running || []).map((r) => r.bundleId).filter(Boolean));
      const present = MAC_PLAYERS.filter((p) => installedIds?.has(p.appId) || runningIds.has(p.appId));
      const check = [...present.filter((p) => runningIds.has(p.appId)).map((p) => p.appId), SYSTEM_EVENTS_ID];
      const statuses = await cachedPermissions(check);
      const players = present.map((p) => {
        const live = runningIds.has(p.appId) ? statuses[p.appId] : null;
        const status = live && live !== "not-running" ? live : lastKnown.get(p.appId) ?? "needed";
        return { id: p.id, name: p.name, appId: p.appId, installed: Boolean(installedIds?.has(p.appId)) || runningIds.has(p.appId), running: runningIds.has(p.appId), permission: status };
      });
      const restart = powerFromPermission(statuses[SYSTEM_EVENTS_ID]);
      return {
        players,
        power: { restart, shutdown: restart },
        spotify: { installed: Boolean(installedIds?.has(SPOTIFY_ID)) || runningIds.has(SPOTIFY_ID) },
      };
    },

    async sessionState() {
      try {
        const row = jsonObject((await jxa(SESSION_JXA)).stdout);
        return typeof row?.locked === "boolean" ? { locked: row.locked } : null;
      } catch {
        return null;
      }
    },

    media,
    mediaCommand,

    async mediaArtwork(key) {
      const descriptor = artworkKeys.get(key);
      if (!descriptor) return null;
      const bytes = descriptor.kind === "url"
        ? await fetchSpotifyArtwork(descriptor.url, { fetchImpl })
        : await musicArtwork(descriptor.persistentId);
      return bytes ? fitArtwork(bytes) : null;
    },

    volume,
    setVolume,

    async powerStatus(verb) {
      if (verb === "lock" || verb === "sleep") return "ready";
      // System Events is a faceless helper; it must be running to be asked.
      let status = (await checkPermissions([SYSTEM_EVENTS_ID]))[SYSTEM_EVENTS_ID];
      if (status === "not-running" || !status) {
        await exec(OPEN, ["-g", "-b", SYSTEM_EVENTS_ID]).catch(() => {});
        status = (await checkPermissions([SYSTEM_EVENTS_ID], "wait-check"))[SYSTEM_EVENTS_ID];
      }
      return powerFromPermission(status);
    },

    async requestPermission(scope) {
      const id = PERMISSION_TARGETS[scope];
      if (!id) throw new Error("unknown permission scope");
      if (id === SYSTEM_EVENTS_ID) {
        await exec(OPEN, ["-g", "-b", SYSTEM_EVENTS_ID]).catch(() => {});
      } else if (!(await runningApps()).some((r) => r.bundleId === id)) {
        // Asking needs the player running, and WinDock never launches it to ask.
        return "not-running";
      }
      const status = (await checkPermissions([id], "ask", { timeout: PERMISSION_WAIT_MS }))[id];
      return status || "needed";
    },

    async openPermissionSettings(scope) {
      if (!PERMISSION_TARGETS[scope]) throw new Error("unknown permission scope");
      await exec(OPEN, [AUTOMATION_SETTINGS_URL]);
    },
  };
}
