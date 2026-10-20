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
 * Media/volume/power controls, now-playing, capture and touchpad are out of
 * scope on macOS for V1; `features` declares that to the server.
 */

import { homedir, totalmem, freemem } from "node:os";
import { join } from "node:path";

export const OSASCRIPT = "/usr/bin/osascript";
export const OPEN = "/usr/bin/open";
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

/**
 * Create the macOS provider.
 * @param {object} opts
 * @param {(file:string,args:string[])=>Promise<{stdout:string}>} opts.exec
 * @param {string[]} [opts.appDirs] directories to scan, in priority order
 * @param {string} [opts.osascript] osascript binary (absolute path)
 */
export function createMacProvider({ exec, appDirs = defaultAppDirs(), osascript = OSASCRIPT } = {}) {
  if (typeof exec !== "function") throw new Error("macos provider requires exec");
  const dirs = Object.freeze([...appDirs].filter((d) => typeof d === "string" && d.startsWith("/")));
  const jxa = (script, args = []) => exec(osascript, osascriptArgv(script, args));

  return {
    id: "macos",
    displayName: "macOS",
    features: Object.freeze({ controls: false, nowPlaying: false }),

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
      const { stdout } = await jxa(RUNNING_JXA);
      return parseRunning(stdout);
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
      const error = new Error("Controls aren't available on the macOS host yet.");
      error.status = 501;
      throw error;
    },

    async nowPlaying() {
      return null;
    },

    async systemStats() {
      const total = totalmem();
      const free = freemem();
      const memory = total > 0 ? Math.round(((total - free) / total) * 100) : null;
      return { cpu: null, memory, battery: null, charging: null };
    },
  };
}
