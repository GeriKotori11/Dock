/** G11: the PWA ships a valid manifest and its dock logic renders headlessly. */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { renderTiles, renderTile, renderNowPlaying, escapeHtml, glyphFor, renderMiniPlayer, renderMediaSheet, renderVolumeRow, miniPlayerText, miniPlayerLabel, renderControls } from "../public/dock.js";
import {
  computerKind, powerCaps, offersPower, shutdownEntry, volumeMode, mediaCaps, showMediaButton, showFullscreenButton, closeTarget,
  createArming, createThrottle, expectDisconnect, readExpected, pillVariant, pillContent, closeOutcome, closeLabels,
  pendingPermission, miniPlayerMode, shutdownDialog, powerToast, powerLabels, ARM_WINDOW_MS, ARM_MIN_GAP_MS, EXPECTED_WINDOW_MS, RESTART_GRACE_MS,
} from "../public/dock-controls.js";
import { normalizeMedia, fromNowPlaying } from "../public/now-playing.js";
import { readNative, displayName, wantsSwitcher, shouldHandOff, postToNative, renderSwitchRow, COMPUTER_NAME_MAX } from "../public/native-bridge.js";

const t = createChecker("pwa");
const PUBLIC = join(import.meta.dirname, "..", "public");
const read = (f) => readFileSync(join(PUBLIC, f), "utf8");

// ---- manifest ----
const manifest = JSON.parse(read("manifest.webmanifest"));
t.equal(manifest.name, "WinDock", "manifest declares the app name");
t.ok(typeof manifest.short_name === "string" && manifest.short_name.length <= 12, "short_name is set and short");
t.equal(manifest.start_url, "/", "manifest declares a start_url");
t.equal(manifest.display, "standalone", "manifest requests standalone display");
t.ok(/^#[0-9a-f]{6}$/i.test(manifest.theme_color), "theme_color is a hex colour");
t.ok(/^#[0-9a-f]{6}$/i.test(manifest.background_color), "background_color is a hex colour");
t.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "manifest declares at least two icons");

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
for (const icon of manifest.icons) {
  const rel = icon.src.replace(/^\//, "");
  const full = join(PUBLIC, rel);
  t.ok(existsSync(full), `declared icon exists on disk: ${icon.src}`);
  if (!existsSync(full)) continue;
  const bytes = readFileSync(full);
  t.ok(bytes.subarray(0, 8).equals(PNG_SIG), `${icon.src} is a real PNG`);
  const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  const [dw, dh] = icon.sizes.split("x").map(Number);
  t.equal(w, dw, `${icon.src} width matches its declared size`);
  t.equal(h, dh, `${icon.src} height matches its declared size`);
  t.ok(statSync(full).size > 0, `${icon.src} is not empty`);
}

// ---- shell wiring ----
const html = read("index.html");
for (const id of ["pair", "app", "dock", "pin", "picker", "nowplaying", "conn"]) {
  t.ok(html.includes(`id="${id}"`), `the shell defines #${id}`);
}
t.ok(html.includes('rel="manifest"'), "the shell links its manifest");
t.ok(html.includes('type="module" src="/app.js"'), "the shell loads app.js as a module");
t.ok(html.includes('name="viewport"'), "the shell declares a viewport for phones");

const appJs = read("app.js");
const ids = [...appJs.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
t.ok(ids.length > 0, "app.js references DOM ids");
for (const id of new Set(ids)) {
  t.ok(html.includes(`id="${id}"`), `app.js id #${id} exists in the shell`);
}
t.ok(appJs.includes('credentials: "same-origin"'), "api calls send the session cookie");

const css = read("style.css");
t.ok(css.includes("grid-template-columns"), "the dock uses a responsive grid");
t.ok(css.includes("100dvh"), "layout uses dynamic viewport height for mobile browsers");
t.ok(css.includes("safe-area-inset"), "layout respects device safe areas");

// ---- headless rendering ----
const empty = renderTiles({ tiles: [] });
t.ok(empty.includes("No tiles pinned"), "an empty dock renders its empty state");
t.deepEqual(renderTiles({}), empty, "a missing tiles array renders the empty state");
t.deepEqual(renderTiles({ tiles: "nope" }), empty, "a malformed tiles value renders the empty state");

const html2 = renderTiles({
  tiles: [
    { kind: "app", id: "c:/a.exe", label: "Alpha", running: true },
    { kind: "app", id: "c:/b.exe", label: "Beta", running: false },
    { kind: "control", verb: "mute-toggle", label: "Mute" },
  ],
});
t.equal((html2.match(/<button/g) || []).length, 3, "every tile renders one button");
t.ok(html2.includes('data-action="launch"'), "app tiles carry the launch action");
t.ok(html2.includes('data-action="control"'), "control tiles carry the control action");
t.ok(html2.includes('data-key="mute-toggle"'), "control tiles carry their verb as the key");
t.ok(html2.includes('data-key="c:/a.exe"'), "app tiles carry their id as the key");
t.equal((html2.match(/is-running/g) || []).length, 1, "only the running app is marked running");
t.equal((html2.match(/aria-pressed="true"/g) || []).length, 1, "the running tile is exposed to assistive tech");
t.ok(html2.includes('aria-label="Alpha, running"') && html2.includes('aria-label="Beta"'), "tiles carry an accessible label that says when the app is running");

// ---- escaping (the dock renders host-controlled app names) ----
const XSS = '<img src=x onerror="alert(1)">';
t.equal(
  escapeHtml(XSS),
  "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
  "escapeHtml neutralises angle brackets and quotes",
);
const hostile = renderTile({ kind: "app", id: XSS, label: XSS, running: false });
t.equal((hostile.match(/<img /g) || []).length, 1, "a hostile app name cannot inject a second image beyond the trusted icon");
t.ok(!hostile.includes('onerror="'), "a hostile app name cannot inject an event handler");
t.ok(hostile.includes("&lt;img"), "the hostile name is present but escaped");
// Positive control: the escaper must be doing work, not returning a constant.
t.equal(escapeHtml("plain"), "plain", "positive control: safe text passes through unchanged");
t.ok(escapeHtml("a&b") === "a&amp;b", "positive control: ampersands are escaped");

// ---- unavailable tiles ----
const gone = renderTile({ kind: "app", id: "com.example.gone", label: "Gone", running: true, available: false });
t.ok(gone.includes("is-unavailable"), "an unavailable tile carries is-unavailable");
t.ok(gone.includes('<span class="tile__hint">Not available</span>'), "an unavailable tile hints Not available");
t.ok(gone.includes('aria-label="Gone, not available on this computer"'), "an unavailable tile explains itself to assistive tech");
t.ok(!gone.includes("tile__dot") && !gone.includes("is-running"), "an unavailable tile shows no running dot");
t.ok(gone.includes('data-action="launch"'), "an unavailable tile keeps its action so the shell can explain it");
const goneEditing = renderTile({ kind: "app", id: "com.example.gone", label: "Gone", available: false }, { editing: true, launcher: true });
t.ok(goneEditing.includes('data-action="options"'), "in arrange mode an unavailable tile opens its options like any tile");
const here = renderTile({ kind: "app", id: "c:/a.exe", label: "Alpha", available: true });
t.ok(!here.includes("is-unavailable") && here.includes('aria-label="Alpha"'), "an available tile renders as before");
t.ok(!renderTile({ kind: "app", id: "c:/a.exe", label: "Alpha" }).includes("is-unavailable"), "a tile without availability (older host) renders as available");
t.ok(/\.tile\.is-unavailable \.tile__glyph \{ filter: grayscale\(1\); opacity: \.38; \}/.test(css), "unavailable icons are greyed and dimmed");
t.ok(!/\.drawer-actions \{[^}]*repeat\(7/.test(css) && /\.drawer-actions \{[^}]*grid-auto-flow: column/.test(css), "the drawer grid reflows to its visible buttons");

// ---- per-host features and platform-neutral copy ----
t.ok(appJs.includes('state.features?.[name] !== false'), "a host without features is treated as fully featured");
t.ok(appJs.includes('const controls = feature("controls") && controlsSheetHtml() !== "";') && appJs.includes('$("drawer-controls").hidden = !controls;'), "#drawer-controls hides when the host lacks controls or the sheet would be empty");
for (const [id, name] of [["tab-controls", "controls"], ["drawer-capture", "capture"], ["drawer-input", "input"]]) {
  t.ok(appJs.includes(`$("${id}").hidden = !feature("${name}")`), `#${id} hides when the host lacks ${name}`);
}
t.ok(appJs.includes("isActive: () => paired && online && !document.hidden && mediaWanted()"), "media polls only while paired, online, visible and wanted");
t.ok(/function mediaWanted\(\) \{\n  if \(!mediaCaps\(caps\(\)\)\.available\) return false;/.test(appJs), "media polls only when the host offers media (or legacy now playing)");
t.ok(appJs.includes('if (paired && !document.hidden && feature("capture")) refreshCapture()'), "capture polls only when the host offers it");
t.ok(appJs.includes(`" isn't available on " + (state.hostName || "this computer") + " anymore. Hold to arrange, then remove it."`), "tapping an unavailable tile explains how to remove it");
for (const text of [
  `"unknown app": "That app isn't installed on this computer anymore."`,
  `"launch failed": "The computer couldn't open that app. It may have been moved or removed."`,
  `"controls unavailable": "Controls aren't available on this computer."`,
  `"internal error": "Your computer couldn't complete that action. Try again."`,
  `"wrong pin": "That PIN doesn’t match. Try the PIN shown on your computer."`,
  "Finding apps on this computer…",
  '" on this computer"',
  '{ macos: "Mac", windows: "Windows" }[state.platform]',
  '" is disconnected. Waiting for it to reconnect."',
]) t.ok(appJs.includes(text), `app.js carries the copy: ${text}`);
for (const old of ["Windows app", '" on your PC"', "this PC", "Your PC is disconnected"]) t.ok(!appJs.includes(old), `app.js no longer says "${old}"`);
t.ok(html.includes("Enter the PIN shown by WinDock on your computer."), "the pair hint is platform neutral");

// ---- six-digit pairing ----
const pinInput = (html.match(/<input id="pin"[^>]*>/) || [""])[0];
t.ok(pinInput.includes('pattern="[0-9]{6}"'), "the PIN input accepts exactly six digits");
t.ok(pinInput.includes('maxlength="6"'), "the PIN input allows six characters");
t.ok(pinInput.includes('placeholder="······"'), "the PIN placeholder shows six dots");
t.ok(!pinInput.includes("{4}") && !pinInput.includes('maxlength="4"'), "the four-digit PIN input is gone");
t.ok(appJs.includes('"invalid pin": "Enter all six digits."'), "an invalid pin asks for all six digits");
t.ok(!appJs.includes("Enter all four digits."), "the four-digit message is gone");
t.ok(appJs.includes('"pairing closed": "Pairing is closed. On your computer, show the PIN again (Windows: tray → Show connection info · Mac: npm run info), then enter the new PIN within 10 minutes."'),
  "a closed pairing window explains how to reopen it");
t.ok(appJs.includes('JSON.stringify({ pin: $("pin").value, deviceName: deviceName() })'), "pairing sends a device name with the PIN");
const nameSource = appJs.match(/function deviceName\(ua = navigator\.userAgent\) \{[\s\S]*?\n\}/);
t.ok(nameSource, "app.js defines deviceName from the user agent");
if (nameSource) {
  const derive = (ua, touch = 0) => new Function("navigator", `${nameSource[0]}; return deviceName(${JSON.stringify(ua)});`)({ maxTouchPoints: touch });
  for (const [ua, touch, want] of [
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36", 5, "Android phone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", 5, "iPhone"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", 5, "iPad"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5, "iPad"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 0, "Browser"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36", 0, "Browser"],
  ]) t.equal(derive(ua, touch), want, `user agent → ${want}${touch ? " (touch)" : ""}`);
}
for (const text of ["Your computer.<br><em>Within reach.</em>", "<h2>Pair this phone</h2>", "Connect to your computer <span", "This phone · screen</button>"]) {
  t.ok(html.includes(text), `the shell carries the copy: ${text}`);
}
for (const old of ["Your PC.", "Hello, desktop.", "Connect to your PC", "screen &amp; sleep"]) t.ok(!html.includes(old), `the shell no longer says "${old}"`);
for (const text of ["Connection lost. Check that WinDock is running on your computer.", "Start WinDock on your computer, then connect with its PIN."]) {
  t.ok(appJs.includes(text), `app.js carries the copy: ${text}`);
}

// ---- picker counts are pluralized ----
const pluralSource = appJs.match(/const pluralize = (\([^)]*\) => [^;]+);/);
t.ok(pluralSource, "app.js defines a pluralize helper");
const pluralize = pluralSource ? new Function("return " + pluralSource[1])() : () => "";
t.equal(pluralize(1, "app"), "1 app", "one app is singular");
t.equal(pluralize(0, "app"), "0 apps", "zero apps is plural");
t.equal(pluralize(2, "app"), "2 apps", "two apps is plural");
t.equal(pluralize(1, "copy", "copies"), "1 copy", "an irregular singular is kept");
t.equal(pluralize(3, "copy", "copies"), "3 copies", "an irregular plural is used");
t.ok(appJs.includes('pluralize(matches.length, "app") + (term ? " found" : " on this computer")'), "the picker count uses the helper");
t.ok(!appJs.includes('matches.length + " apps"'), "the picker no longer says \"1 apps\"");

// ---- reconnect pill ----
const pill = html.match(/<div id="reconnect"[^>]*>/)?.[0] || "";
t.ok(pill.includes('role="status"') && pill.includes('aria-live="polite"'), "the reconnect pill is a polite live region");
t.ok(pill.includes('data-visible="false"'), "the reconnect pill starts hidden");
t.ok(html.indexOf('id="reconnect"') < html.indexOf('id="dock"') && html.includes('id="reconnect-text"'), "the pill sits at the top of the dock with its own text");
t.ok(appJs.includes('const computerName = (fallback = "your computer") => displayName(readNative(), state.hostName, fallback);') && appJs.includes('pillContent(variant, variant === "reconnecting" ? name : sentenceName())'), "the pill names the computer (the phone's nickname inside a native shell)");
t.ok(/offlineTimer = setTimeout\(\(\) => setOffline\(!online && paired\), 1500\)/.test(appJs), "the pill waits 1.5 s and rechecks before showing");
t.ok(/function syncOffline\(\) \{\n  if \(online \|\| !paired\) return setOffline\(false\);/.test(appJs), "reconnecting or unpairing hides the pill at once");
t.ok(/function setConn\(on\) \{[\s\S]*?syncOffline\(\);\n\}/.test(appJs), "every connection change updates the pill");
t.ok(appJs.includes('$("dock").classList.toggle("is-offline", Boolean(content?.dim));'), "the dock dims with the offline pills (not the locked one)");
t.ok(appJs.includes("if (!online) return notify(offlineMessage(), true);") && appJs.includes('function offlineMessage() { return sentenceName() + " is disconnected. Waiting for it to reconnect."; }'), "tapping while offline keeps the toast, with the computer's name");
t.ok(/\.dock\.is-offline \.dock-page \{ opacity: \.55; \}/.test(css) && /\.dock-page \{ transition: opacity \.2s; \}/.test(css), "offline pages dim to .55 over 200 ms");
t.ok(/\.reconnect \{[^}]*var\(--glass-bg\)[^}]*var\(--glass-border\)/.test(css), "the pill uses the glass tokens");
t.ok(/@media \(prefers-reduced-motion: reduce\) \{ \.reconnect__dot \{ animation: none; \} \}/.test(css), "the pill's dot does not pulse with reduced motion");
t.ok(/\.dock-page--single-row \{[^}]*align-content: center/.test(css), "a single row of tiles is vertically centred");
t.ok(html.includes('id="host-name" class="bar__host">Your computer<') && html.includes('id="drawer-host">Your computer<'), "host name placeholders are platform neutral");

// ---- native shell bridge (design spec section 11) ----
t.equal(readNative({}), null, "a browser has no native capabilities");
t.equal(readNative(undefined), null, "no window means no native capabilities");
t.equal(readNative({ WinDockNative: "ios" }), null, "a non-object WinDockNative is ignored");
t.equal(readNative({ WinDockNative: { platform: "windows", switcher: true } }), null, "an unknown platform is ignored");
t.deepEqual(readNative({ WinDockNative: { platform: "ios", switcher: true, computerName: "Studio PC" } }),
  { platform: "ios", switcher: true, computerName: "Studio PC" }, "iOS capabilities are read");
t.deepEqual(readNative({ WinDockNative: { platform: "android", switcher: "yes", computerName: 42, extra: "<script>" } }),
  { platform: "android", switcher: false, computerName: null }, "only a boolean switcher and a string name are trusted; other fields are dropped");
t.equal(readNative({ WinDockNative: { platform: "ios", computerName: "x".repeat(COMPUTER_NAME_MAX + 1) } }).computerName, null, "an over-long name is ignored");
t.equal(readNative({ WinDockNative: { platform: "ios", computerName: "x".repeat(COMPUTER_NAME_MAX) } }).computerName, "x".repeat(COMPUTER_NAME_MAX), "a 60-character name is kept");
t.equal(readNative({ WinDockNative: { platform: "ios", computerName: "   " } }).computerName, null, "a blank name is ignored");
t.equal(readNative({ get WinDockNative() { throw new Error("boom"); } }), null, "a throwing getter reads as a browser");
// Read at use time: a window gaining WinDockNative later is seen on the next read.
const lateWin = {};
t.equal(readNative(lateWin), null, "before injection there are no capabilities");
lateWin.WinDockNative = { platform: "android", switcher: true };
t.equal(readNative(lateWin)?.platform, "android", "capabilities injected later are seen on the next read");

t.equal(displayName(readNative({ WinDockNative: { platform: "ios", computerName: "Studio PC" } }), "DESKTOP-42", "Your computer"), "Studio PC", "the nickname replaces the host name");
t.equal(displayName(readNative({ WinDockNative: { platform: "ios" } }), "DESKTOP-42", "Your computer"), "DESKTOP-42", "without a nickname the host name stays");
t.equal(displayName(null, "DESKTOP-42", "Your computer"), "DESKTOP-42", "a browser keeps the host name");
t.equal(displayName(null, "", "your computer"), "your computer", "with no names the fallback is used");

t.equal(wantsSwitcher(null), false, "a browser keeps the plain drawer row");
t.equal(wantsSwitcher(readNative({ WinDockNative: { platform: "ios", switcher: false } })), false, "a shell without a switcher keeps the plain row");
t.equal(wantsSwitcher(readNative({ WinDockNative: { platform: "ios", switcher: true } })), true, "a shell with a switcher gets the switch button");

const row = renderSwitchRow({ name: XSS, connState: "on", connText: "Connected" });
t.ok(row.startsWith('<button id="drawer-switch" class="drawer-switch" type="button"'), "the switch row is one button");
t.ok(row.includes('id="drawer-host"') && row.includes('id="drawer-conn" data-state="on">Connected<'), "the switch row keeps the host and connection ids");
t.ok(!row.includes("<img") && row.includes("&lt;img"), "a hostile nickname is escaped in the switch row");
t.ok(row.includes(">Switch<svg") && row.includes('<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>'), "the row ends with Switch and an up/down chevron");
t.ok(row.includes('<rect x="3" y="4" width="18" height="13" rx="3"/>'), "the row starts with the monitor icon");
t.ok(renderSwitchRow({ name: "PC", connState: '"><b>' }).includes('data-state="off"'), "an unexpected state renders as off");

// Native dispatch to fake bridges.
const sent = [];
const iosWin = { webkit: { messageHandlers: { windock: { postMessage: (m) => sent.push(["ios", m]) } } } };
const androidCalls = [];
const androidWin = { WinDockAndroid: { switchComputer: () => androidCalls.push("switchComputer"), ready: () => androidCalls.push("ready"), unauthorized: () => androidCalls.push("unauthorized") } };
t.equal(postToNative(iosWin, { type: "ready", switcher: true }), true, "ready reaches the iOS handler");
t.equal(postToNative(iosWin, { type: "unauthorized" }), true, "unauthorized reaches the iOS handler");
t.equal(postToNative(iosWin, { type: "switch" }), true, "switch reaches the iOS handler");
t.deepEqual(sent, [["ios", { type: "ready", switcher: true }], ["ios", { type: "unauthorized" }], ["ios", { type: "switch" }]], "iOS gets the messages as posted");
t.equal(postToNative(androidWin, { type: "ready", switcher: true }), true, "ready reaches WinDockAndroid.ready");
t.equal(postToNative(androidWin, { type: "unauthorized" }), true, "unauthorized reaches WinDockAndroid.unauthorized");
t.equal(postToNative(androidWin, { type: "switch" }), true, "switch reaches WinDockAndroid.switchComputer");
t.deepEqual(androidCalls, ["ready", "unauthorized", "switchComputer"], "Android gets the matching bridge calls");
t.equal(postToNative({}, { type: "ready", switcher: true }), false, "a browser has nowhere to post ready");
t.equal(postToNative({ WinDockAndroid: { showPhoneSettings() {} } }, { type: "ready" }), false, "an older Android bridge without ready is left alone");
t.equal(postToNative(iosWin, { type: "eval" }), false, "unknown message types are not sent");
t.equal(postToNative({ webkit: { messageHandlers: { windock: { postMessage() { throw new Error("gone"); } } } } }, { type: "switch" }), false, "a throwing bridge does not break the dock");

t.equal(shouldHandOff(readNative(iosWin), true), false, "a message handler alone (no WinDockNative) keeps the web PIN page");
t.equal(shouldHandOff(readNative({ WinDockNative: { platform: "ios", switcher: true } }), true), true, "a 401 inside a native shell hands off instead of the web PIN page");
t.equal(shouldHandOff(readNative({ WinDockNative: { platform: "ios" } }), false), false, "a non-401 failure is not handed off");
t.equal(shouldHandOff(readNative({}), true), false, "browsers still get the web PIN page");

// Wiring in app.js.
t.ok(appJs.includes('showPair("Enter the current PIN to reconnect.", true)'), "every API 401 is flagged unauthorized");
t.ok(/if \(shouldHandOff\(readNative\(\), unauthorized\)\) \{[\s\S]*?postToNative\(window, \{ type: "unauthorized" \}\);\n    return;\n  \}\n  \$\("pair"\)\.hidden = false;/.test(appJs),
  "a native 401 posts unauthorized and returns before the web PIN page is shown");
t.ok(appJs.includes('readySent = postToNative(window, { type: "ready", switcher: true })'), "the dock posts ready to native");
t.ok(appJs.includes("try { await refresh(); showApp(); connect(); announceReady(); }"), "ready is posted after the first state is painted");
t.ok(appJs.includes('window.addEventListener("windock-native-ready"'), "the dock listens for a late native injection");
t.ok(appJs.includes('postToNative(window, { type: "switch" })'), "the switch row calls native");
t.ok(appJs.includes('if (wantsSwitcher(native) && !row.classList.contains("has-switch"))'), "the switch row replaces the plain row only when native offers it");
t.ok(html.includes('<div class="drawer-connection"><span id="drawer-host">Your computer</span><span id="drawer-conn" data-state="off">Connecting</span></div>'),
  "without native the drawer row stays plain and non-interactive");
t.ok(/\.drawer-switch \{[^}]*min-height: 48px[^}]*border-radius: 14px[^}]*background: #ffffff08/.test(css), "the switch row follows spec 5.12");

t.equal(glyphFor({ kind: "control", verb: "lock" }), "🔒", "control tiles get their verb glyph");
t.equal(glyphFor({ kind: "app", label: "firefox" }), "F", "app tiles fall back to an initial");
t.equal(glyphFor({ kind: "app", label: "" }), "?", "an unnamed app still gets a glyph");

t.equal(renderNowPlaying(null), "", "no now-playing renders nothing");
t.equal(renderNowPlaying({ title: "" }), "", "an empty title renders nothing");
const np = renderNowPlaying({ title: XSS, artist: "A", playing: true });
t.ok(!np.includes("<img"), "now playing escapes a hostile title");
t.ok(np.includes("&lt;img"), "the hostile title is escaped rather than dropped");

// ---- dock controls (docs/design/DOCK-CONTROLS.md) ----
// A fake clock for the timer-driven state machines.
function fakeClock() {
  let now = 1000, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = until;
    },
    get pending() { return timers.size; },
  };
}
const WIN = {
  controls: true, nowPlaying: true, capture: true, input: true, close: true,
  media: { sources: "system", players: [{ id: "spotify", name: "Spotify", appId: "Spotify.exe", installed: true, running: false, permission: "not-required" }], artwork: true, sessions: true },
  volume: { get: true, set: true, mute: true }, power: { lock: "ready", sleep: "ready", restart: "ready", shutdown: "ready" },
};
const MAC = {
  controls: true, nowPlaying: false, capture: false, input: false, close: true,
  media: { sources: "apps", players: [{ id: "spotify", name: "Spotify", appId: "com.spotify.client", installed: true, running: true, permission: "needed" }, { id: "music", name: "Music", appId: "com.apple.Music", installed: true, running: false, permission: "granted" }] },
  volume: { get: true, set: true, mute: true }, power: { lock: "ready", sleep: "ready", restart: "needs-permission", shutdown: "needs-permission" },
};
const LEGACY_VERBS = ["volume-up", "volume-down", "mute-toggle", "media-play-pause", "media-next", "media-previous", "lock", "sleep", "shutdown", "restart"];

// Visibility rules matrix (6.1–6.6, 7.3).
t.equal(computerKind("macos"), "Mac", "{Mac/PC} is Mac on macOS hosts");
t.equal(computerKind("windows"), "PC", "{Mac/PC} is PC elsewhere");
t.deepEqual(powerCaps({ features: WIN, verbs: [], allowDestructive: true }), { legacy: false, lock: "ready", sleep: "ready", restart: "ready", shutdown: "ready" }, "a new host's power map is read as-is");
t.deepEqual(powerCaps({ features: WIN, allowDestructive: false }), { legacy: false, lock: "ready", sleep: null, restart: null, shutdown: null }, "allowDestructive false hides sleep, restart and shut down, never lock (8.6)");
t.deepEqual(powerCaps({ features: { power: { lock: "ready", sleep: "maybe", shutdown: "denied" } } }), { legacy: false, lock: "ready", sleep: null, restart: null, shutdown: "denied" }, "unknown power statuses and missing keys are not offered (6.6)");
t.deepEqual(powerCaps({ features: { controls: true }, verbs: LEGACY_VERBS, allowDestructive: true }), { legacy: true, lock: "ready", sleep: "ready", restart: "ready", shutdown: "ready" }, "an older host maps its power verbs (7.3)");
t.deepEqual(powerCaps({ features: { controls: true }, verbs: LEGACY_VERBS, allowDestructive: false }), { legacy: true, lock: null, sleep: null, restart: null, shutdown: null }, "an older host without allowDestructive offers no power at all (it rejects lock too)");
t.deepEqual(powerCaps({ features: {}, verbs: [] }), { legacy: true, lock: null, sleep: null, restart: null, shutdown: null }, "no power verbs means no power group");
t.equal(offersPower(powerCaps({ features: MAC }), "shutdown"), true, "needs-permission still counts as offered (6.3)");
t.deepEqual(shutdownEntry(powerCaps({ features: WIN })), { shutdown: true, restart: true, label: "Shut down" }, "the Shut down entry offers both");
t.deepEqual(shutdownEntry({ restart: "ready" }), { shutdown: false, restart: true, label: "Restart" }, "a host with only restart labels the entry Restart");
t.equal(shutdownEntry({ lock: "ready" }), null, "no shut down or restart hides the entry");
t.equal(volumeMode({ features: WIN }), "slider", "get and set give the volume slider");
t.equal(volumeMode({ features: { volume: { get: true } }, verbs: [] }), null, "a volume map without set and no verbs hides the row");
t.equal(volumeMode({ features: { controls: true }, verbs: ["volume-up", "volume-down", "mute-toggle"] }), "buttons", "an older host gets Quieter · Mute · Louder (7.3)");
t.equal(volumeMode({ features: {}, verbs: [] }), null, "no volume capability hides the row");
const winMedia = mediaCaps({ features: WIN });
t.ok(winMedia.available && !winMedia.legacy && winMedia.sources === "system" && winMedia.sessions, "a Windows host offers system media with sessions");
t.equal(mediaCaps({ features: MAC }).sources, "apps", "a Mac host offers per-player media");
t.equal(mediaCaps({ features: MAC }).players.length, 2, "players are read from the capability map");
t.deepEqual(mediaCaps({ features: { media: { players: [{ id: 3 }, null, { id: "x", name: "X", permission: "bogus" }] } } }).players, [{ id: "x", name: "X", appId: null, installed: false, running: false, permission: "not-required" }], "malformed players are dropped and unknown permissions normalised");
const legacyMedia = mediaCaps({ features: { nowPlaying: true }, verbs: ["media-play-pause", "media-next"] });
t.ok(legacyMedia.available && legacyMedia.legacy, "an older host with nowPlaying uses the legacy media path");
t.deepEqual(legacyMedia.transport, { previous: false, playPause: true, next: true }, "legacy transport follows the listed verbs");
t.equal(mediaCaps({ verbs: [] }).available, true, "a host that sends no features keeps missing = on for nowPlaying (6.6)");
t.equal(mediaCaps({ features: { nowPlaying: false } }).available, false, "nowPlaying false and no media map means no media");
t.equal(showMediaButton({ features: { nowPlaying: false }, verbs: ["volume-up"] }), true, "the drawer's Media button shows for volume alone");
t.equal(showMediaButton({ features: { nowPlaying: false }, verbs: [] }), false, "no media and no volume hides the Media button");
t.equal(showFullscreenButton({ native: true, fullscreenEnabled: true }), false, "Fullscreen is hidden inside the native apps");
t.equal(showFullscreenButton({ native: false, fullscreenEnabled: false }), false, "Fullscreen is hidden without the Fullscreen API");
t.equal(showFullscreenButton({ native: false, fullscreenEnabled: true }), true, "Fullscreen shows in a browser that supports it");

const slack = { kind: "app", id: "slack", label: "Slack" };
const runningSlack = [{ id: "slack", pid: 1, closable: true }, { id: "slack", pid: 2, closable: true }, { id: "explorer", pid: 3, closable: false }];
t.deepEqual(closeTarget(slack, { features: WIN, running: runningSlack }), { count: 2 }, "a running closable app gets a close button for every instance");
for (const [why, tile, ctx] of [
  ["the host has no close feature (older host)", slack, { features: { controls: true }, running: runningSlack }],
  ["features.close is false", slack, { features: { close: false }, running: runningSlack }],
  ["the app is not running", { kind: "app", id: "word", label: "Word" }, { features: WIN, running: runningSlack }],
  ["the host marks it not closable", { kind: "app", id: "explorer", label: "File Explorer" }, { features: WIN, running: runningSlack }],
  ["one instance is not closable", slack, { features: WIN, running: [{ id: "slack", pid: 1, closable: true }, { id: "slack", pid: 2 }] }],
  ["Arrange is on", slack, { features: WIN, running: runningSlack, editing: true }],
  ["the dock is offline", slack, { features: WIN, running: runningSlack, offline: true }],
  ["the setting is off", slack, { features: WIN, running: runningSlack, enabled: false }],
  ["the tile is unavailable", { ...slack, available: false }, { features: WIN, running: runningSlack }],
  ["it is a control tile", { kind: "control", verb: "lock", label: "Lock" }, { features: WIN, running: runningSlack }],
]) t.equal(closeTarget(tile, ctx), null, `no close button when ${why}`);

// Close arming state machine (9.2).
t.equal(ARM_WINDOW_MS, 3000, "the arming window is 3 s");
t.equal(ARM_MIN_GAP_MS, 350, "the double-tap guard is 350 ms");
{
  const clock = fakeClock();
  const events = [];
  const arming = createArming({ ...clock, onChange: (armed, reason, key) => events.push([armed, reason, key]) });
  t.equal(arming.tap("app:slack"), "armed", "the first tap arms");
  t.ok(arming.isArmed("app:slack") && arming.key === "app:slack", "the armed key is tracked");
  clock.advance(200);
  t.equal(arming.tap("app:slack"), "ignored", "a second tap inside 350 ms is ignored (double-tap habit)");
  t.ok(arming.isArmed("app:slack"), "an ignored tap keeps it armed");
  clock.advance(200);
  t.equal(arming.tap("app:slack"), "confirm", "a second tap after 350 ms confirms");
  t.equal(arming.key, null, "confirming disarms");
  t.equal(clock.pending, 0, "confirming clears the timeout");
  arming.tap("app:word");
  clock.advance(2999);
  t.ok(arming.isArmed("app:word"), "still armed just before 3 s");
  clock.advance(1);
  t.equal(arming.key, null, "the arm times out after 3 s");
  t.deepEqual(events.at(-1), [null, "timeout", "app:word"], "a timeout is reported");
  t.equal(arming.tap("app:word"), "armed", "a tap after the timeout arms again rather than closing");
  t.equal(arming.tap("app:code"), "armed", "arming another tile is a fresh arm");
  t.ok(!arming.isArmed("app:word") && arming.isArmed("app:code"), "arming another tile disarms the first");
  t.deepEqual(events.slice(-2), [[null, "replaced", "app:word"], ["app:code", "armed", "app:code"]], "the replaced arm is reported before the new one");
  t.equal(arming.disarm("page"), true, "a page swipe disarms");
  t.equal(arming.disarm("page"), false, "disarming twice is a no-op");
  clock.advance(5000);
  t.deepEqual(events.at(-1), [null, "page", "app:code"], "a cleared arm never fires its old timeout");
}

// Tile markup with the close button (5.1, 11, 17).
const closeTile = renderTile({ kind: "app", id: "slack", label: "Slack", running: true, close: { count: 2, state: "rest" } }, { launcher: true });
t.ok(closeTile.startsWith('<div class="tile-slot" data-slot-key="app:slack" data-close-state="rest"><button class="tile tile--app is-running"'), "a closable tile is wrapped in a .tile-slot with the tile button first");
t.equal((closeTile.match(/<button/g) || []).length, 2, "the close button is a sibling button, not nested");
t.ok(/<\/button><button class="tile__close" type="button" data-close-for="app:slack" aria-label="Close all 2 Slack windows">/.test(closeTile), "the close button names every window it will close");
t.ok(closeTile.includes('aria-label="Slack, running"'), "the tile's name says it is running");
t.ok(closeTile.includes('<span class="tile__close-pill" aria-hidden="true">') && closeTile.includes("Close all</span>"), "two or more instances arm as Close all");
t.ok(!closeTile.match(/tile__close[^>]*data-tile-key/), "the close button carries no tile key, so it never starts a drag or Arrange");
const single = renderTile({ kind: "app", id: "word", label: "Word", running: true, close: { count: 1, state: "armed" } }, { launcher: true });
t.ok(single.includes('data-close-state="armed"') && single.includes('aria-label="Confirm: close Word"') && single.includes("Close</span>"), "an armed close button reads Confirm and Close");
const closing = renderTile({ kind: "app", id: "word", label: "Word", running: true, close: { count: 1, state: "closing" } }, { launcher: true });
t.ok(/class="tile tile--app is-running"[^>]*aria-busy="true" aria-disabled="true"/.test(closing) && /tile__close"[^>]*aria-busy="true"/.test(closing), "closing marks the tile and its button busy");
t.ok(renderTile({ kind: "app", id: "word", label: "Word", running: true, close: { count: 1, fresh: true } }, { launcher: true }).includes('class="tile__close is-fresh"'), "a newly running app's close button fades in");
t.ok(!renderTile({ kind: "app", id: "word", label: "Word", running: true, close: { count: 1 } }, { editing: true, launcher: true }).includes("tile__close"), "Arrange never renders a close button");
t.ok(!renderTile({ kind: "app", id: "word", label: "Word", running: false, close: { count: 1 } }, { launcher: true }).includes("tile__close"), "a stopped app never renders a close button");
t.ok(!renderTile({ kind: "app", id: "x", label: XSS, running: true, close: { count: 1 } }, { launcher: true }).includes('onerror="'), "a hostile app name is escaped in the close button");
const sleepTile = renderTile({ kind: "control", verb: "sleep", label: "Sleep", arm: { armed: true, text: "Sleep", icon: "moon", label: "Confirm: put Studio PC to sleep" } }, { launcher: true });
t.ok(sleepTile.includes('data-armed="true"') && sleepTile.includes('aria-label="Confirm: put Studio PC to sleep"') && sleepTile.includes('<span class="tile__arm">'), "a pinned Sleep tile arms with the same pill (two taps)");
t.ok(renderTile({ kind: "control", verb: "media-play-pause", label: "Play / Pause", playing: true }).includes('<path d="M8 5v14M16 5v14"/>'), "the Play/Pause tile shows Pause while media plays");
t.ok(renderTile({ kind: "control", verb: "media-play-pause", label: "Play / Pause" }).includes('<path d="m7 4 14 8-14 8z"/>'), "the Play/Pause tile shows Play otherwise");
t.ok(/\.tile__close \{[^}]*min-width: 44px; height: 44px/.test(css), "the close button's hit area is 44 px");
t.ok(/\.tile__close-badge \{[^}]*width: 24px; height: 24px[^}]*background: var\(--badge\)/.test(css), "the close badge is 24 px on the badge token");
t.ok(/\.tile__close-pill \{[^}]*height: 30px[^}]*background: var\(--danger\); color: var\(--on-danger\); font-size: 12px; font-weight: 650/.test(css), "the armed pill is 30 px, danger on on-danger, 12/650");
for (const token of ["--ease-out: cubic-bezier(0.23, 1, 0.32, 1)", "--badge: rgba(12, 20, 24, .78)", "--text-3: #8c9c9c"]) t.ok(css.includes(token), `style.css defines ${token}`);
t.ok(appJs.includes('const onClose = Boolean(event.target.closest(".tile__close"));') && appJs.includes("if (state.tiles.length && !editing && !onClose) gesture.holdTimer"), "pressing the close button never starts the Arrange timer");
t.ok(appJs.includes("if (gesture.onClose && Math.hypot(dx, dy) > 10) suppressCloseUntil"), "more than 10 px of movement on the close button is a swipe, not a tap");

// Close outcomes and copy (5.1, 13).
t.deepEqual(closeLabels("Slack", 1), { rest: "Close Slack", armed: "Confirm: close Slack", pill: "Close", live: "Tap again to close Slack." }, "close copy for one window");
t.equal(closeLabels("Slack", 3).rest, "Close all 3 Slack windows", "close copy for several windows");
t.deepEqual(closeOutcome({ status: 200, body: { requested: 1, closed: 1, stillOpen: [] }, app: "Slack", computer: "Studio PC" }), { message: "Slack closed", tone: "success", gone: true }, "a closed app");
t.deepEqual(closeOutcome({ status: 200, body: { requested: 3, closed: 3, stillOpen: [] }, app: "Notepad", computer: "Studio PC" }), { message: "Closed 3 Notepad windows", tone: "success", gone: true }, "several closed windows");
t.deepEqual(closeOutcome({ status: 200, body: { requested: 1, closed: 0, stillOpen: [{ pid: 1 }] }, app: "Word", computer: "Studio PC" }), { message: "Word is still open. It may be asking to save changes on Studio PC.", tone: "neutral", gone: false }, "an app still open after 5 s is neutral, not an error");
t.deepEqual(closeOutcome({ status: 200, body: { requested: 3, closed: 2, stillOpen: [{ pid: 1 }] }, app: "Notepad", computer: "Studio PC" }), { message: "Closed 2 of 3 Notepad windows. One may be asking to save changes on Studio PC.", tone: "neutral", gone: false }, "a partial close");
t.deepEqual(closeOutcome({ status: 404, body: { error: "not running" }, app: "Slack", computer: "Studio PC" }), { message: "Slack was already closed.", tone: "success", gone: true }, "an app already gone is success");
for (const status of [403, 500, 501, 0]) t.deepEqual(closeOutcome({ status, body: null, app: "Slack", computer: "Studio PC" }), { message: "Studio PC couldn't close Slack. Try again, or close it on the computer.", tone: "error", gone: false }, `status ${status} is a failure`);

// Volume throttle (8.4).
{
  const clock = fakeClock();
  const sent = [];
  const throttle = createThrottle((value, final) => sent.push([value, final, clock.now()]), { ...clock, intervalMs: 100 });
  throttle.input(10);
  t.deepEqual(sent, [[10, false, 1000]], "the first drag value goes out at once");
  clock.advance(30); throttle.input(20);
  clock.advance(30); throttle.input(30);
  t.equal(sent.length, 1, "values inside the interval wait");
  clock.advance(40);
  t.deepEqual(sent.at(-1), [30, false, 1100], "the latest value goes out at the end of the interval");
  clock.advance(10); throttle.input(40);
  clock.advance(20); throttle.commit(45);
  t.deepEqual(sent.at(-1), [45, true, 1130], "release always sends the final value");
  clock.advance(500);
  t.equal(sent.filter(([v]) => v === 40).length, 0, "a pending value is dropped when the final value is sent");
  const per = sent.filter(([, final]) => !final).map(([, , at]) => at);
  t.ok(per.every((at, i) => i === 0 || at - per[i - 1] >= 100), "never more than one value per 100 ms while dragging");
  let count = 0;
  const burst = createThrottle(() => count++, { ...clock, intervalMs: 100 });
  for (let i = 0; i < 50; i++) { burst.input(i); clock.advance(10); }
  t.ok(count <= 6, `a 500 ms drag sends at most 6 values (sent ${count})`);
}

// Pill variants and expected disconnects (5.6, 5.7).
t.equal(EXPECTED_WINDOW_MS, 60000, "an expected disconnect counts for 60 s");
t.equal(RESTART_GRACE_MS, 300000, "restarting falls back after 5 minutes");
const asleep = expectDisconnect("sleep", "Studio PC", 10_000);
t.deepEqual(asleep, { reason: "asleep", computer: "Studio PC", at: 10_000 }, "sleep stores the asleep reason");
t.equal(expectDisconnect("shutdown", "PC", 1).reason, "off", "shut down stores off");
t.equal(expectDisconnect("restart", "PC", 1).reason, "restarting", "restart stores restarting");
t.equal(expectDisconnect("lock", "PC", 1), null, "lock expects no disconnect");
t.deepEqual(readExpected(JSON.stringify(asleep)), asleep, "the memory survives sessionStorage");
for (const bad of ["{", null, "{}", JSON.stringify({ reason: "nap", at: 1 }), JSON.stringify({ reason: "off" })]) t.equal(readExpected(bad), null, `malformed memory reads as none: ${bad}`);
const base = { paired: true, online: false, offlineVisible: true, computer: "Studio PC", now: 20_000 };
t.equal(pillVariant({ ...base, paired: false }), null, "no pill while unpaired");
t.equal(pillVariant({ ...base, online: true, locked: false }), null, "no pill while connected and unlocked");
t.equal(pillVariant({ ...base, online: true, locked: true }), "locked", "connected and locked shows the locked pill");
t.equal(pillVariant({ ...base, offlineVisible: false, expected: asleep, disconnectedAt: 11_000 }), null, "nothing before the 1.5 s offline threshold");
t.equal(pillVariant({ ...base, expected: null, disconnectedAt: 11_000 }), "reconnecting", "an unexpected drop is the plain reconnect pill");
t.equal(pillVariant({ ...base, expected: asleep, disconnectedAt: 11_000 }), "asleep", "a drop within 60 s of Sleep says asleep");
t.equal(pillVariant({ ...base, expected: asleep, disconnectedAt: 10_000 + 60_001 }), "reconnecting", "a drop more than 60 s after the command is unexpected");
t.equal(pillVariant({ ...base, expected: asleep, disconnectedAt: 9_000 }), "reconnecting", "a drop before the command is unexpected");
t.equal(pillVariant({ ...base, expected: { ...asleep, computer: "Other PC" }, disconnectedAt: 11_000 }), "reconnecting", "memory for another computer is ignored");
t.equal(pillVariant({ ...base, expected: expectDisconnect("shutdown", "Studio PC", 10_000), disconnectedAt: 11_000 }), "off", "shut down shows off");
const restarting = expectDisconnect("restart", "Studio PC", 10_000);
t.equal(pillVariant({ ...base, expected: restarting, disconnectedAt: 11_000, now: 10_000 + RESTART_GRACE_MS }), "restarting", "restarting holds for 5 minutes");
t.equal(pillVariant({ ...base, expected: restarting, disconnectedAt: 11_000, now: 10_000 + RESTART_GRACE_MS + 1 }), "reconnecting", "then falls back to reconnecting");
t.equal(pillVariant({ ...base, locked: true, expected: null, disconnectedAt: 11_000 }), "reconnecting", "offline replaces the locked pill");
t.deepEqual(pillContent("asleep", "Studio PC"), { text: "Studio PC is asleep · Wake it to reconnect", icon: "moon", pulse: false, dim: true }, "asleep copy, moon, still");
t.deepEqual(pillContent("off", "Studio PC"), { text: "Studio PC is off · Turn it on to reconnect", icon: "power", pulse: false, dim: true }, "off copy, power, still");
t.deepEqual(pillContent("restarting", "Studio PC"), { text: "Studio PC is restarting…", icon: null, pulse: true, dim: true }, "restarting keeps the pulsing dot");
t.deepEqual(pillContent("locked", "Studio PC"), { text: "Studio PC is locked", icon: "lock", pulse: false, dim: false }, "locked does not dim the dock");
t.deepEqual(pillContent("reconnecting", "Studio PC"), { text: "Reconnecting to Studio PC…", icon: null, pulse: true, dim: true }, "the existing reconnect copy");
t.equal(pillContent(null, "x"), null, "no variant, no pill");
t.ok(html.includes('<span id="reconnect-icon" class="reconnect__icon" aria-hidden="true"></span>'), "the pill has an icon slot");
t.ok(/\.reconnect\[data-pulse="false"\] \.reconnect__dot \{ display: none; \}/.test(css), "still variants hide the pulsing dot");

// Power copy (5.6, 13).
t.deepEqual(shutdownDialog({ shutdown: true, restart: true }, "Studio PC"), { title: "Shut down Studio PC?", body: "Apps with unsaved work may ask on the computer before it turns off. To reconnect, you'll need to turn Studio PC on.", primary: "shutdown", restart: true }, "the shut down dialog offers Restart inside it");
t.deepEqual(shutdownDialog({ shutdown: false, restart: true }, "Studio PC"), { title: "Restart Studio PC?", body: "Apps with unsaved work may ask on the computer first. WinDock reconnects when it's back.", primary: "restart", restart: false }, "a restart-only host gets the restart dialog");
t.equal(shutdownDialog(null, "x"), null, "no entry, no dialog");
t.equal(powerToast("lock", "Studio PC"), "Studio PC locked", "lock toast");
t.equal(powerToast("sleep", "Studio PC"), "Studio PC is going to sleep", "sleep toast");
t.equal(powerToast("shutdown", "Studio PC"), "Shutting down Studio PC", "shut down toast");
t.equal(powerToast("restart", "Studio PC"), "Restarting Studio PC", "restart toast");
t.deepEqual(powerLabels("Studio PC", { shutdown: true, restart: true }), { lock: "Lock Studio PC", sleep: "Put Studio PC to sleep", shutdown: "Shut down or restart Studio PC" }, "power button names");
t.equal(powerLabels("Studio PC", { shutdown: false, restart: true }).shutdown, "Restart Studio PC", "the entry is named for what it offers");
t.ok(!appJs.includes("confirmPower") && appJs.includes('if (verb === "shutdown" || verb === "restart") return openShutdown();'), "only shut down and restart ask first");
t.ok(appJs.includes('if (key === "sleep" && button.dataset.tileKey) {') && appJs.includes("const result = arming.tap(button.dataset.tileKey);"), "a pinned Sleep tile needs two taps; the drawer's Sleep acts at once");
t.ok(html.includes('<button id="confirm-restart" class="button" type="button" hidden><span data-icon="refresh"></span>Restart</button>'), "the confirm dialog has a Restart button");
t.ok(html.includes('id="confirm-cancel" class="button" type="button" autofocus>Cancel<'), "Cancel keeps autofocus");

// Mini player and Media sheet renderers per state (5.2, 5.3).
const spotify = normalizeMedia({ source: { id: "spotify", name: "Spotify", appId: "com.spotify.client" }, title: "Houdini", artist: "Dua Lipa", album: "Radical Optimism", playing: true, positionMs: 72000, durationMs: 185000, artwork: "/api/media/artwork?key=9f2c", controls: { previous: true, next: true, playPause: true, seek: true, shuffle: true, repeat: true }, shuffle: true, repeat: "one" });
t.equal(miniPlayerMode({ caps: winMedia, media: spotify }), "player", "a session shows the mini player");
t.equal(miniPlayerMode({ caps: winMedia, media: spotify, enabled: false }), "hidden", "the setting hides it");
t.equal(miniPlayerMode({ caps: winMedia, media: spotify, offlineVisible: true }), "hidden", "offline hides it");
t.equal(miniPlayerMode({ caps: mediaCaps({ features: { nowPlaying: false } }), media: spotify }), "hidden", "no media capability hides it");
t.equal(miniPlayerMode({ caps: winMedia, media: normalizeMedia({ source: null }) }), "hidden", "no session hides it");
const macCaps = mediaCaps({ features: MAC });
t.equal(miniPlayerMode({ caps: macCaps, media: normalizeMedia({ source: null }) }), "permission", "a running Mac player that needs permission shows the compact strip");
t.equal(miniPlayerMode({ caps: macCaps, media: normalizeMedia({ source: null }), dismissed: true }), "hidden", "until dismissed");
t.equal(miniPlayerMode({ caps: mediaCaps({ features: { ...MAC, media: { ...MAC.media, players: [{ ...MAC.media.players[0], permission: "denied" }] } } }), media: normalizeMedia({ source: null }) }), "hidden", "denied hides on the dock (explained in the sheet)");
t.deepEqual(pendingPermission(macCaps, normalizeMedia({ source: null })), { player: "spotify", name: "Spotify", appId: "com.spotify.client", status: "needed" }, "the pending permission names the player");
t.deepEqual(pendingPermission(winMedia, normalizeMedia({ source: null, permission: { player: "music", status: "denied" } })).status, "denied", "a live permission from /api/media is used");
const mini = renderMiniPlayer({ mode: "player", media: spotify });
t.ok(mini.startsWith('<div class="mini" role="region" aria-label="Now playing"'), "the mini player is a Now playing region");
t.ok(mini.includes('aria-label="Houdini by Dua Lipa, Spotify. Open media controls."'), "its open button has the spec's name");
t.ok(mini.includes('<img class="art-img" src="/api/media/artwork?key=9f2c"') && mini.includes('class="media-badge"'), "artwork with the source badge");
t.ok(mini.includes('data-media="pause" aria-label="Pause"') && mini.includes('aria-label="Previous track"') && mini.includes('aria-label="Next track"'), "transport is Previous · Pause · Next");
const paused = renderMiniPlayer({ mode: "player", media: normalizeMedia({ source: { name: "Chrome", appId: "chrome.exe" }, title: "Live from Tirana", playing: false }) });
t.ok(paused.includes('<span class="mini__sub">Paused · Chrome</span>') && paused.includes('data-media="play" aria-label="Play"'), "paused without an artist says Paused · {source} and offers Play");
t.ok(!paused.includes("art-img") && paused.includes("/api/apps/icon?v=3&amp;id=chrome.exe"), "no artwork: the source app's icon fills the slot");
t.deepEqual(miniPlayerText(normalizeMedia({ source: { name: "Chrome" }, title: "" })), { title: "Playing in Chrome", sub: "No track details" }, "a session without metadata");
t.deepEqual(miniPlayerText(normalizeMedia({ source: { name: "Spotify" }, title: "Houdini", artist: "Dua Lipa", playing: false })), { title: "Houdini", sub: "Dua Lipa" }, "paused with an artist keeps the artist");
t.equal(miniPlayerLabel(fromNowPlaying({ title: "Song", artist: "Artist", playing: true })), "Song by Artist. Open media controls.", "a legacy session has no source in its name");
t.ok(renderMiniPlayer({ mode: "player", media: fromNowPlaying({ title: "Song", playing: true }) }).includes('<span class="media-glyph">'), "a legacy session falls back to the music glyph");
t.equal(renderMiniPlayer({ mode: "hidden", media: spotify }), "", "hidden renders nothing");
t.ok(renderMiniPlayer({ mode: "player", media: normalizeMedia({ source: { name: "S" }, title: "T", controls: { previous: false } }) }).match(/data-media="previous"[^>]*disabled/), "an unavailable control stays in place, disabled");
const strip = renderMiniPlayer({ mode: "permission", permission: { player: "spotify", name: "Spotify", appId: "com.spotify.client", status: "needed" } });
t.ok(strip.includes("Allow Spotify control") && strip.includes(">Allow</button>") && strip.includes('data-media-dismiss aria-label="Not now"'), "the compact permission strip");
t.ok(!renderMiniPlayer({ mode: "player", media: normalizeMedia({ source: { name: XSS }, title: XSS }) }).includes("<img src=x"), "hostile track data is escaped");

const sheet = renderMediaSheet({ media: spotify, caps: macCaps, computer: "Geri's MacBook Air", kind: "Mac", showOn: true });
t.ok(sheet.includes("Spotify</span><small>on Geri&#39;s MacBook Air</small>"), "the header names the source and computer");
t.ok(sheet.includes("<span>Show on Mac</span>"), "Show on {Mac/PC} when the player can be focused");
t.ok(sheet.includes('<p class="media-album">Radical Optimism</p>') && sheet.includes("data-seek") && sheet.includes(">3:05</span>"), "the rich source fills album, seek and duration");
t.ok(sheet.includes('data-media="shuffle" aria-label="Shuffle" aria-pressed="true"') && sheet.includes('data-media="repeat" aria-label="Repeat: One" aria-pressed="true"'), "shuffle and repeat show their state in aria-pressed");
t.ok(sheet.includes('<path d="M11 10.5 12.5 9.5v5"/>'), "repeat one shows the 1 glyph");
const generic = renderMediaSheet({ media: normalizeMedia({ source: { name: "Chrome", appId: "chrome.exe" }, title: "Jazz", artist: "Trio", sessions: [{ sessionId: "a", name: "Chrome", current: true }, { sessionId: "b", name: "Spotify" }] }), caps: winMedia, computer: "Studio PC" });
t.ok(!generic.includes("media-album") && !generic.includes("media-progress") && (generic.match(/media-btn--ghost/g) || []).length === 2, "rows a source can't fill are absent, transport stays centred");
t.ok(generic.includes("<small>· 2 players</small>") && generic.includes("data-media-sources"), "two sessions make the source a switcher");
t.ok(!generic.includes("Show on"), "no Show on without a focusable app");
t.ok(renderMediaSheet({ media: normalizeMedia({ source: { name: "Chrome" }, title: "Jazz", sessions: [{ sessionId: "a", name: "Chrome" }, { sessionId: "b", name: "Spotify" }] }), caps: winMedia, sourcesOpen: true }).includes('id="media-sources"'), "the switcher opens a list of players");
const nothingWin = renderMediaSheet({ media: normalizeMedia({ source: null }), caps: winMedia, computer: "Studio PC" });
t.ok(nothingWin.includes('<h2 class="media-head__title">Media</h2>') && nothingWin.includes("<h3>Nothing playing</h3>") && nothingWin.includes("Play something on Studio PC and it will show up here, with its controls."), "nothing playing on Windows");
t.ok(nothingWin.includes("Resume last player") && nothingWin.includes('data-media-launch="spotify"') && nothingWin.includes("Open Spotify"), "Resume last player and Open Spotify when installed and not running");
const nothingMac = renderMediaSheet({ media: normalizeMedia({ source: null }), caps: mediaCaps({ features: { media: { sources: "apps", players: [{ id: "music", name: "Music", installed: true, running: false }] } } }), computer: "Mac" });
t.ok(nothingMac.includes("Open Spotify or Music on Mac to control it here.") && nothingMac.includes("Open Music") && !nothingMac.includes("Resume last player"), "nothing playing on a Mac offers the installed players");
t.ok(renderMediaSheet({ media: null, caps: mediaCaps({ features: { media: { sources: "apps", players: [] } } }), computer: "Mac" }).includes("WinDock can control Spotify and Music on a Mac. Neither is installed on Mac."), "a Mac with no supported player says so");
const perm = renderMediaSheet({ media: null, caps: macCaps, permission: { player: "spotify", name: "Spotify", status: "needed" }, computer: "Geri's MacBook Air" });
t.ok(perm.includes("Control Spotify from your phone") && perm.includes("Tap Ask on Mac.") && perm.includes(">Ask on Mac</button>") && perm.includes(">Not now</button>"), "the permission card");
t.ok(renderMediaSheet({ caps: macCaps, permission: { player: "spotify", name: "Spotify", status: "needed", asking: true }, computer: "X" }).includes("Waiting for your Mac… Click OK in the prompt on X."), "asking shows the waiting copy");
t.ok(renderMediaSheet({ caps: macCaps, permission: { player: "spotify", name: "Spotify", status: "denied" }, computer: "X" }).includes("Spotify control is off on your Mac") && renderMediaSheet({ caps: macCaps, permission: { player: "spotify", name: "Spotify", status: "denied" } }).includes("Open Settings on Mac"), "denied explains and offers Open Settings on Mac");
const offlineSheet = renderMediaSheet({ media: spotify, caps: macCaps, computer: "Studio PC", online: false });
const offlineButtons = offlineSheet.match(/<button[^>]*data-media="[^"]*"[^>]*>/g) || [];
t.ok(offlineSheet.includes("Reconnecting to Studio PC…") && offlineButtons.length === 5 && offlineButtons.every((tag) => tag.includes(" disabled")), "offline greys the controls and says it is reconnecting");
t.ok(renderVolumeRow({ mode: "slider" }).includes('type="range" min="0" max="100"') && renderVolumeRow({ mode: "slider" }).includes('aria-valuetext="0 percent"'), "the volume slider is a native range with a spoken value");
t.ok(renderVolumeRow({ mode: "buttons" }).includes("Quieter") && renderVolumeRow({ mode: "buttons" }).includes('data-media-control="mute-toggle"'), "legacy volume is three buttons");
t.equal(renderVolumeRow({ mode: null }), "", "no volume, no row");

// Controls sheet keeps Sound, Display and Your PC/Mac (4, 17).
const controlsHtml = renderControls(LEGACY_VERBS.concat("brightness-set"), true, { power: powerCaps({ features: MAC }), kind: "Mac" });
t.ok(!controlsHtml.includes("Playback") && !controlsHtml.includes('data-key="media-play-pause"'), "the Playback card is gone");
t.ok(controlsHtml.includes("<h3>Your Mac</h3><p>Shut down and restart ask first.</p>"), "the power card is Your Mac with the new hint");
t.ok(!renderControls(LEGACY_VERBS, true, { power: powerCaps({ features: WIN, allowDestructive: false }), kind: "PC" }).includes('data-key="sleep"'), "power the host doesn't offer is hidden in Controls");

// Shell wiring for the new surfaces.
t.ok(html.includes('<dialog id="media" class="sheet media-sheet" aria-label="Media">'), "the Media sheet is a <dialog>, so Android Back closes it first");
t.ok(html.indexOf('id="drawer-apps"') < html.indexOf('id="drawer-media"') && html.indexOf('id="drawer-media"') < html.indexOf('id="drawer-controls"'), "Media sits after Apps in the drawer");
t.ok(html.includes('<div id="drawer-power" class="drawer-power" role="group" aria-label="Power" hidden>'), "the drawer has a power group");
t.ok(html.includes('<div id="mini-player" class="mini-player"></div>') && html.includes('<div id="live" class="sr-only" aria-live="polite"></div>'), "the mini player container and a polite live region");
t.ok(html.includes("Close buttons on open apps<input id=\"close-buttons\"") && html.includes("Now playing on the dock<input id=\"mini-setting\""), "the two Layout switches");
t.ok(/\.glass-drawer \{ width: min\(92vw, 760px\); \}/.test(css), "the drawer widens to 760");
t.ok(/body\.is-immersive\.has-mini \.tile, body\.is-immersive\.has-mini \.tile-slot, body\.is-immersive\.has-mini \.drag-ghost \{ --display-icon: min\(var\(--icon-size\), calc\(\(100dvh - 64px - 68px\) \* var\(--icon-scale\)\)/.test(css), "icons shrink to make room for the mini player");
t.ok(/@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ transition: none !important; animation: none !important;/.test(css), "reduced motion still stops every transition and animation");
t.ok(appJs.includes("const volumeThrottle = createThrottle((level, final) => sendVolume({ level }, final), { intervalMs: 100 });"), "the slider is throttled to one level per 100 ms");

t.done("pwa verification passed");
