/** G11: the PWA ships a valid manifest and its dock logic renders headlessly. */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { renderTiles, renderTile, renderNowPlaying, escapeHtml, glyphFor, renderMiniPlayer, renderMediaSheet, renderVolumeRow, miniPlayerText, miniPlayerLabel, renderControls } from "../public/dock.js";
import {
  computerKind, powerCaps, offersPower, shutdownEntry, volumeMode, mediaCaps, showMediaButton, showFullscreenButton, closeTarget,
  createArming, createThrottle, expectDisconnect, readExpected, pillVariant, pillContent, closeOutcome, closeLabels,
  pendingPermission, miniPlayerMode, shutdownDialog, powerToast, powerLabels, ARM_WINDOW_MS, ARM_MIN_GAP_MS, EXPECTED_WINDOW_MS, RESTART_GRACE_MS,
  stepVolume, miniVolumeMode, miniMuteMode, MINI_VOLUME_MIN_WIDTH, MINI_VOLUME_MUTE_MIN_WIDTH, miniPlayerWidth, miniVolumeShown, miniVolumeChip, createHoldRepeat, createVolumeStepper, miniSeekMode, seekAria, seekFromPointer, seekKey,
  VOLUME_STEP, HOLD_DELAY_MS, HOLD_REPEAT_MS, CHIP_HIDE_MS,
} from "../public/dock-controls.js";
import { normalizeMedia, fromNowPlaying, spokenTime, createMediaPoller } from "../public/now-playing.js";
import { readNative, displayName, wantsSwitcher, shouldHandOff, postToNative, renderSwitchRow, COMPUTER_NAME_MAX } from "../public/native-bridge.js";
import { addSpotifyTile, hasTile, removeTile, moveTile, toWireTiles, tileKey } from "../public/tiles.js";
import {
  SP_COPY, SP_TABS, LIKED_CONTEXT, SEARCH_DEBOUNCE_MS, LONG_PRESS_MS, WAIT_STOP_MS, MAX_TILES, formatCount, spotifyAccount, spotifyInstalled, isSpotifySource, spotifyMode,
  spotifyTab, nextTab, spotifyImageUrl, normalizePage, mergePage, normalizeSearch, normalizeQueue, normalizeDevices, isLikedContext, deviceIcon, deviceSubtitle,
  normalizeSpotifyStatus, playBody, spotifyTile, spotifyError, createSearch, spotifyBrand, renderSpTabs, renderSpEntry, renderSpWaiting, renderSpLibrary,
  renderSpSearchPanel, renderSpResults, renderSpDevices, renderSpFooter, renderSpUpNext, renderLikeButton, spotifyMenuActions, renderSpMenuActions,
  upNextButton, renderUpNextButton, renderSpQueuePanel, mediaBackStep, createQueueLoader, formatDuration, QUEUE_REFRESH_MS, UP_NEXT_WIDE_MIN,
} from "../public/spotify.js";

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
// The badge sits ON the artwork's top-right corner (centre --close-inset in on both axes), scaled with the icon.
t.ok(/\.tile-slot \{[^}]*--icon-pad: 0; --close-inset: calc\(var\(--glyph\) \* \(var\(--icon-pad\) \+ 0\.07\)\)/.test(css), "the close inset scales with the icon (0.07 x icon past the artwork margin)");
t.ok(css.includes(':root[data-platform="macos"] .tile-slot { --icon-pad: 0.098; }'), "macOS icons carry a 824/1024 margin, so the badge moves in to the artwork");
t.ok(/\.tile__close \{[^}]*top: calc\(50% \+ var\(--glyph-shift\) - var\(--glyph\) \/ 2 \+ var\(--close-inset\) - 22px\); right: calc\(50% - var\(--glyph\) \/ 2 \+ var\(--close-inset\) - 22px\)/.test(css), "the 44 px hit area is centred on the badge (22 px), which is centred --close-inset inside the icon corner");
t.ok(appJs.includes("document.documentElement.dataset.platform = state.platform"), "the host platform reaches CSS");
{
  // Geometry: badge centre relative to the artwork corner, at phone icon sizes (8, 6, 4 per page) and classic 72 px.
  const centre = (glyph, pad) => { const inset = glyph * (pad + 0.07); return { fromArtworkCorner: inset - glyph * pad }; };
  for (const glyph of [82.6, 89, 107, 140, 72]) {
    const mac = centre(glyph, 0.098).fromArtworkCorner, win = centre(glyph, 0).fromArtworkCorner;
    t.ok(Math.abs(mac - glyph * 0.07) < 1e-9 && Math.abs(win - glyph * 0.07) < 1e-9, `badge centre is ${(glyph * 0.07).toFixed(1)} px inside the artwork corner at a ${glyph} px icon`);
  }
  t.ok(Math.abs(89 * 0.07 - 6.2) < 0.1, "about 6 px in at the phone's 8-per-page icon");
  // The armed pill grows leftwards from the hit area's right edge (padding 10): it ends inside the icon box.
  const pillRight = (glyph, pad) => glyph / 2 - glyph * (pad + 0.07) + 22 - 10;
  t.ok([82.6, 107, 140].every((g) => pillRight(g, 0) < g / 2 + 13 && pillRight(g, 0.098) < g / 2), "the armed pill never extends more than a few px past the icon's right edge, so the rightmost column stays on screen");
}
t.ok(/\.tile__close-badge \{[^}]*width: 24px; height: 24px[^}]*background: var\(--badge\)/.test(css), "the close badge is 24 px on the badge token");
t.ok(/\.tile__close-pill \{[^}]*height: 30px[^}]*background: var\(--danger\); color: var\(--on-danger\); font-size: 12px; font-weight: 650/.test(css), "the armed pill is 30 px, danger on on-danger, 12/650");
for (const token of ["--ease-out: cubic-bezier(0.23, 1, 0.32, 1)", "--badge: rgba(12, 20, 24, .78)", "--text-3: #8c9c9c"]) t.ok(css.includes(token), `style.css defines ${token}`);
t.ok(appJs.includes('const onClose = Boolean(event.target.closest(".tile__close"));') && appJs.includes("if (realTiles(state.tiles).length && !editing && !onClose) gesture.holdTimer"), "pressing the close button never starts the Arrange timer");
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
t.ok(html.includes('<button id="confirm-restart" class="button" type="button" hidden><span data-icon="restart"></span>Restart</button>'), "the confirm dialog has a Restart button with the restart icon");
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
t.ok(/^<div class="mini( has-seek)?" role="region" aria-label="Now playing"/.test(mini), "the mini player is a Now playing region");
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

// Mini player volume buttons, width rule and seek line (5.2 additions).
{
  t.equal(VOLUME_STEP, 5, "a volume step is 5");
  t.deepEqual([stepVolume(45, 1), stepVolume(45, -1), stepVolume(98, 1), stepVolume(3, -1), stepVolume(100, 1), stepVolume(0, -1)], [50, 40, 100, 0, 100, 0], "steps clamp to 0–100");
  t.equal(stepVolume(null, 1), null, "no known level, no step");
  t.equal(miniVolumeMode({ features: WIN }), "level", "volume.set gives level buttons");
  t.equal(miniVolumeMode({ features: { volume: { get: true, set: false } }, verbs: LEGACY_VERBS }), null, "a new host that can't set the volume shows none (no legacy fallback)");
  t.equal(miniVolumeMode({ features: { controls: true }, verbs: ["volume-up", "volume-down"] }), "legacy", "older hosts use the volume verbs");
  t.equal(miniVolumeMode({ features: { controls: true }, verbs: ["media-next"] }), null, "no volume, no buttons");
  t.equal(miniPlayerWidth({ viewportWidth: 844, containerWidth: 844 }), 405.12, "the base width stays min(440, 48vw, 100% - 48px)");
  t.equal(Math.round(miniPlayerWidth({ viewportWidth: 844, containerWidth: 844, wide: true })), 523, "with volume: min(560, 62vw, 100% - 48px) = 523 at 844");
  t.equal(miniPlayerWidth({ viewportWidth: 932, containerWidth: 932, wide: true }), 560, "560 at 932");
  t.equal(miniVolumeShown({ mode: "level", viewportWidth: 844, containerWidth: 844 }), true, "844 wide shows the buttons");
  t.equal(miniVolumeShown({ mode: "level", viewportWidth: 667, containerWidth: 667 }), false, "below 440 px (62vw of 667 = 413) the buttons hide");
  t.equal(miniVolumeShown({ mode: "level", immersive: false, viewportWidth: 932, containerWidth: 932 }), false, "the classic footer player never shows them");
  t.equal(miniVolumeShown({ mode: null, viewportWidth: 932, containerWidth: 932 }), false, "no volume capability, no buttons");
  t.deepEqual([miniVolumeChip({ level: 45 }), miniVolumeChip({ level: 45, muted: true }), miniVolumeChip({ level: null })], ["45%", "Muted", ""], "chip copy");
  t.equal(CHIP_HIDE_MS, 1200, "the chip hides after 1.2 s");

  const wide = renderMiniPlayer({ mode: "player", media: spotify, volume: "level" });
  t.ok(wide.startsWith('<div class="mini mini--wide has-seek"'), "volume buttons widen the player");
  t.ok(wide.indexOf('aria-label="Next track"') < wide.indexOf('class="mini__divider"') && wide.indexOf('class="mini__divider"') < wide.indexOf('data-mini-vol="down"'), "a hairline after Next, then the volume buttons");
  t.ok(wide.includes('data-mini-vol="down" aria-label="Volume down"') && wide.includes('data-mini-vol="up" aria-label="Volume up"'), "Volume down / Volume up names");
  t.ok(wide.includes('<span class="mini__chip" data-mini-chip aria-live="polite"></span>'), "the level chip is a polite live region");
  t.ok(wide.includes('<path d="m11 4-6 5H2v6h3l6 5zM16 12h6"/>') && wide.includes('<path d="m11 4-6 5H2v6h3l6 5zM16 12h6m-3-3v6"/>'), "speaker-minus / speaker-plus glyphs");
  t.ok(/\.mini__btn \{[^}]*width: 44px; height: 44px/.test(css), "volume buttons are 44 px targets");
  t.ok(css.includes(".mini__divider { width: 1px; height: 18px; flex-shrink: 0; background: var(--line); }"), "the divider uses the hairline token");
  t.ok(css.includes("body.is-immersive .mini.mini--wide { width: min(560px, 62vw, 100% - 48px); }") && css.includes("width: min(440px, 48vw, 100% - 48px); }"), "the wide width rule in CSS");
  const plain = renderMiniPlayer({ mode: "player", media: spotify });
  t.ok(!plain.includes("mini__vol") && !plain.includes("mini--wide"), "without volume the player keeps its width and has no buttons");
  const legacyVol = renderMiniPlayer({ mode: "player", media: spotify, volume: "legacy" });
  t.ok(legacyVol.includes('data-mini-vol-mode="legacy"') && !legacyVol.includes("data-mini-chip"), "legacy volume buttons have no level chip");
  t.ok(appJs.includes('verb: direction > 0 ? "volume-up" : "volume-down"'), "legacy buttons send the volume verbs");
  t.ok(appJs.includes('const own = event.target.closest("[data-mini-seek-hit], [data-mini-vol], [data-mini-mute]");') && appJs.includes("event.stopPropagation();"), "volume, mute and seek never start the mini player's swipe or tap-to-open");
  t.ok(appJs.includes('else if (data.miniVol) return true;'), "a volume tap never opens the media sheet");

  // Seek line rules.
  t.equal(miniSeekMode(spotify), "seek", "seekable with a duration: draggable");
  const noSeek = normalizeMedia({ source: { name: "Chrome" }, title: "T", durationMs: 200000, positionMs: 1000 });
  t.equal(miniSeekMode(noSeek), "progress", "a duration without seek: read-only line");
  t.equal(miniSeekMode(normalizeMedia({ source: { name: "Chrome" }, title: "T" })), null, "no duration: no line");
  t.ok(wide.includes('data-mini-seek="seek"') && wide.includes('role="slider"') && wide.includes('aria-valuemin="0" aria-valuemax="185" aria-valuenow="0" aria-valuetext="0 seconds of 3 minutes 5 seconds"'), "the seek hit area is a slider with aria values in seconds");
  // The seek row: elapsed · line · total, its own row under the controls.
  t.ok(wide.includes('<span class="mini__seek-now" data-mini-seek-now aria-hidden="true">0:00</span>') && wide.includes('<span class="mini__seek-end" aria-hidden="true">3:05</span>'), "seekable: elapsed time left, total time right");
  t.ok(wide.includes('class="mini__seek-thumb"') && !wide.includes("data-mini-seek-time"), "seekable: a thumb, and no floating time label (the elapsed time updates live instead)");
  t.ok(wide.indexOf('<div class="mini__row">') < wide.indexOf('data-mini-vol="up"') && wide.indexOf('data-mini-vol="up"') < wide.indexOf("data-mini-seek=") && wide.indexOf('data-mini-seek=') > wide.lastIndexOf("</button>"), "the seek row comes after the controls row, outside it");
  t.ok(/<div class="mini__seek is-seekable" data-mini-seek="seek" style="--p:0">.*<div class="mini__seek-hit"[^>]*role="slider"[^>]*><\/div><\/div>/.test(wide), "the slider hit area is a direct child of the seek row");
  const prog = renderMiniPlayer({ mode: "player", media: noSeek });
  t.ok(prog.includes('data-mini-seek="progress"') && prog.includes('class="mini has-seek"') && prog.includes("mini__seek-now") && prog.includes(">3:20</span>"), "progress only: the row with both times");
  t.ok(!prog.includes('role="slider"') && !prog.includes("mini__seek-thumb") && !prog.includes("mini__seek-hit") && prog.includes('data-mini-seek="progress" style="--p:0" aria-hidden="true"'), "progress only: no slider, no thumb, hidden from assistive tech");
  const noDur = renderMiniPlayer({ mode: "player", media: normalizeMedia({ source: { name: "Chrome" }, title: "T" }) });
  t.ok(!noDur.includes("mini__seek") && !noDur.includes("has-seek"), "no duration: no row and the compact height");
  t.deepEqual(seekAria(72000, 185000, spokenTime), { min: 0, max: 185, now: 72, text: "1 minute 12 seconds of 3 minutes 5 seconds" }, "slider values while playing");
  t.equal(seekFromPointer(150, { left: 50, width: 400 }, 200000), 50000, "pointer to position");
  t.deepEqual([seekFromPointer(0, { left: 50, width: 400 }, 200000), seekFromPointer(999, { left: 50, width: 400 }, 200000)], [0, 200000], "pointer clamps to the line");
  t.deepEqual([seekKey(72000, 185000, "ArrowRight"), seekKey(72000, 185000, "ArrowLeft"), seekKey(2000, 185000, "ArrowDown"), seekKey(183000, 185000, "ArrowUp"), seekKey(1, 2, "Enter")], [77000, 67000, 0, 185000, null], "arrow keys move 5 s, clamped");
  t.ok(/\.mini__seek-bar \{[^}]*flex: 1;[^}]*height: 4px/.test(css) && css.includes("background: var(--accent); transform: scaleX(var(--p))"), "4 px line taking the free width, accent fill");
  t.ok(/\.mini__seek \{[^}]*color: var\(--muted\); font-size: 11px;[^}]*font-variant-numeric: tabular-nums/.test(css), "times are 11 px tabular numerals in the secondary colour");
  t.ok(css.includes(".mini__seek-thumb { position: absolute; top: 50%; left: calc(var(--p) * 100%); width: 14px; height: 14px;") && css.includes("transform: scale(.5715)") && css.includes(".mini__seek.is-dragging .mini__seek-thumb, .mini__seek:has(.mini__seek-hit:focus-visible) .mini__seek-thumb { transform: none; }"), "an 8 px thumb at rest, 14 px while dragging or focused");
  t.ok(css.includes(".mini__seek-hit { position: absolute; z-index: 3; inset: 0;"), "the hit area is the whole seek row");
  // Geometry: the seek row's hit area sits entirely below every button (border-box sizes from the CSS).
  const px = (re) => Number((css.match(re) || [])[1]);
  const miniH = px(/\.mini\.has-seek \{ height: (\d+)px; \}/), rowH = px(/\.mini\.has-seek \.mini__row \{ flex: 0 0 (\d+)px; \}/), seekH = px(/\.mini__seek \{[^}]*flex: 0 0 (\d+)px;/), btnH = px(/\.mini__btn \{[^}]*height: (\d+)px/), border = 1;
  t.deepEqual([miniH, rowH, seekH, btnH], [78, 50, 26, 44], "player 78 tall with the seek row (58 + 20): controls 50, seek row 26, buttons 44");
  t.equal(border + rowH + seekH + border, miniH, "the two rows fill the player exactly");
  const btnRect = { top: border + (rowH - btnH) / 2, bottom: border + (rowH + btnH) / 2 };
  const hitRect = { top: border + rowH, bottom: border + rowH + seekH };
  t.ok(hitRect.top >= btnRect.bottom && hitRect.bottom <= miniH, "the seek hit area never intersects a button's rect");
  t.ok(hitRect.bottom - hitRect.top >= 24, "the hit area is at least 24 px tall");
  // Buttons still win taps, as a guarantee (same stacking context: no wrapper sets z-index).
  const zOf = (sel) => Number((css.match(new RegExp(sel.replace(/[.]/g, "\\.") + " \\{[^}]*z-index: (\\d+)")) || [])[1]);
  t.ok(css.includes(".mini__btn { position: relative; z-index: 4; }") && zOf(".mini__btn") > zOf(".mini__seek-hit"), "buttons (z 4) stack above the seek hit area (z 3)");
  t.ok(!/\.mini__seek \{[^}]*z-index/.test(css) && !/\.mini__vol \{[^}]*z-index/.test(css) && !/\.mini__row \{[^}]*z-index/.test(css), "no wrapper creates a stacking context that would undo that order");
  t.ok(!css.includes("margin-top: -14px") && !css.includes("--inset-l"), "the old overlapping 28 px hit strip is gone");
  // Height class and the dock reflow.
  t.ok(appJs.includes('document.body.classList.toggle("has-mini-seek", floating && Boolean(target.querySelector(".mini.has-seek")));') && appJs.includes('document.body.classList.remove("has-mini", "has-mini-seek")'), "the body knows when the taller player shows");
  t.ok(css.includes("body.is-immersive.has-mini.has-mini-seek .workspace { padding-bottom: 102px; }") && css.includes("calc((100dvh - 64px - 88px) * var(--icon-scale))") && css.includes("body.is-immersive.has-mini.has-mini-seek .page-dots { bottom: 96px; }"), "with the seek row the dock reserves 20 px more and icons shrink to fit");
  t.ok(appJs.includes('const bar = line.querySelector(".mini__seek-bar");') && appJs.includes("seekFromPointer(event.clientX, miniSeek.bar.getBoundingClientRect(), media.durationMs)"), "drag positions map onto the line itself, not the whole row");
  t.ok(appJs.includes("if (now) now.textContent = formatTime(position);"), "the elapsed time follows the line, live while dragging");
  t.ok(appJs.includes('mediaCommand("seek", value);') && appJs.includes("if (commit && media)"), "the seek request goes out once, on release");

  // Mute button in the mini player (5.2 addition).
  t.equal(miniMuteMode({ features: WIN }), "level", "features.volume.mute gives the mute toggle");
  t.equal(miniMuteMode({ features: { volume: { get: true, set: true } }, verbs: LEGACY_VERBS }), null, "a new host without volume.mute shows no mute button (no legacy fallback)");
  t.equal(miniMuteMode({ features: { controls: true }, verbs: ["volume-up", "volume-down", "mute-toggle"] }), "legacy", "older hosts use the mute-toggle verb");
  t.equal(miniMuteMode({ features: { controls: true }, verbs: ["volume-up", "volume-down"] }), null, "no mute verb, no mute button");
  t.deepEqual([MINI_VOLUME_MIN_WIDTH, MINI_VOLUME_MUTE_MIN_WIDTH], [440, 484], "the mute button raises the width threshold by its 44 px");
  t.equal(miniVolumeShown({ mode: "level", mute: "level", viewportWidth: 844, containerWidth: 844 }), true, "844 wide (523 px) fits volume and mute");
  t.equal(miniVolumeShown({ mode: "level", mute: "level", viewportWidth: 932, containerWidth: 932 }), true, "932 wide (560 px) fits volume and mute");
  t.equal(miniVolumeShown({ mode: "level", mute: "level", viewportWidth: 760, containerWidth: 760 }), false, "760 wide (471 px) hides the whole group when it has mute");
  t.equal(miniVolumeShown({ mode: "level", mute: null, viewportWidth: 760, containerWidth: 760 }), true, "the same width still fits − / + without mute");
  const withMute = renderMiniPlayer({ mode: "player", media: spotify, volume: "level", mute: "level", muted: false });
  t.ok(withMute.includes('<button class="mini__btn mini__mute" type="button" data-mini-mute="level" aria-label="Mute" aria-pressed="false">'), "the mute toggle: Mute, not pressed");
  t.ok(withMute.indexOf('data-mini-vol="up"') < withMute.indexOf("data-mini-mute") && withMute.indexOf("data-mini-mute") < withMute.indexOf("data-mini-seek"), "mute sits right of Volume up, inside the controls row");
  const mutedHtml = renderMiniPlayer({ mode: "player", media: spotify, volume: "level", mute: "level", muted: true });
  t.ok(mutedHtml.includes('data-mini-mute="level" aria-label="Unmute" aria-pressed="true"'), "muted: Unmute, pressed");
  t.ok(!renderMiniPlayer({ mode: "player", media: spotify, volume: "level" }).includes("data-mini-mute"), "no mute capability, no mute button");
  t.ok(!renderMiniPlayer({ mode: "player", media: spotify, mute: "level" }).includes("data-mini-mute"), "no volume group, no mute button");
  const legacyMute = renderMiniPlayer({ mode: "player", media: spotify, volume: "legacy", mute: "legacy", muted: true });
  t.ok(legacyMute.includes('data-mini-mute="legacy" aria-label="Mute">') && !legacyMute.includes("aria-pressed"), "legacy mute: no state shown (the host can't report it)");
  t.ok(renderMiniPlayer({ mode: "player", media: spotify, volume: "level", mute: "level", online: false }).match(/data-mini-mute="level"[^>]*disabled/), "offline: mute disabled");
  t.ok(css.includes('.mini__mute[aria-pressed="true"] { background: #b4edcc1f; color: var(--accent); }'), "muted: mint tint like the other active toggles");
  t.ok(appJs.includes('if (mode === "legacy") return api("/api/control", { method: "POST", body: JSON.stringify({ verb: "mute-toggle" }) }).catch(report);'), "legacy mute sends the mute-toggle verb");
  t.ok(appJs.includes("volume.muted = volume.muted !== true;") && appJs.includes("sendVolume({ muted: volume.muted }, true);") && appJs.includes('else if (data.miniMute) toggleMute(data.miniMute);') && appJs.includes('else if ("volumeMute" in data) toggleMute("level");'), "mini and sheet mute share one optimistic toggle");
  t.ok(appJs.includes("const change = unmuteWithLevel ? { level, muted: false } : { level };") && appJs.includes('if (direction <= 0 || volume.muted !== true || miniMuteMode(caps()) !== "level") return;'), "Volume up while muted sends muted:false with the new level");
  t.ok(appJs.includes('await volumePoller.command(() => api("/api/volume", { method: "POST", body: JSON.stringify(change) })') && appJs.includes("const volumePoller = createMediaPoller({"), "volume changes run through an ordered poller like media commands");
  t.ok(!appJs.includes("refreshVolume(); }, 2000);"), "the old unordered volume poll is gone");
  // A poll that started before the mute reply can't flip the optimistic state back.
  {
    let applied = { muted: false };
    let resolvePoll;
    const poller = createMediaPoller({ load: () => new Promise((resolve) => { resolvePoll = resolve; }), onChange: (fresh) => { if (fresh) applied = fresh; }, isActive: () => false, intervalMs: 1e6 });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const poll = poller.refresh();
    await settle();
    applied = { muted: true }; // optimistic
    await poller.command(async () => ({ level: 45, muted: true }));
    resolvePoll({ level: 45, muted: false }); // stale read from before the toggle
    await poll;
    t.equal(applied.muted, true, "a stale volume poll doesn't undo the optimistic mute");
    let resolveHeld;
    const held = poller.command(() => new Promise((resolve) => { resolveHeld = resolve; }));
    const during = poller.refresh();
    await settle();
    resolvePoll({ level: 45, muted: false });
    await during;
    t.equal(applied.muted, true, "a poll while the change is in flight is held");
    resolveHeld({ level: 45, muted: false });
    await held;
    t.equal(applied.muted, false, "the change's own reply reconciles");
    poller.stop();
  }

  // Hold-repeat and throttle timing with fake timers.
  t.deepEqual([HOLD_DELAY_MS, HOLD_REPEAT_MS], [400, 150], "hold starts after 400 ms, repeats every 150 ms");
  const clock = fakeClock();
  const fired = [];
  const hold = createHoldRepeat(() => fired.push(clock.now()), clock);
  hold.start();
  clock.advance(1000);
  hold.stop();
  t.deepEqual(fired.map((at) => at - 1000), [0, 400, 550, 700, 850, 1000], "fires at once, then after 400 ms every 150 ms");
  clock.advance(1000);
  t.equal(fired.length, 6, "stop ends the repeat");
  t.equal(clock.pending, 0, "no timer left after stop");

  const c2 = fakeClock();
  let level = 45;
  const sent = [];
  const stepper = createVolumeStepper({ ...c2, getLevel: () => level, onLevel: (v) => { level = v; }, send: (v, final) => sent.push([v, final, c2.now()]) });
  stepper.press(1);
  stepper.release();
  t.deepEqual(sent, [[50, false, 1000]], "a tap sends one level (+5) at once");
  c2.advance(500);
  stepper.press(-1);
  c2.advance(700);
  stepper.release();
  t.deepEqual(sent.slice(1).map(([v]) => v), [45, 40, 35, 30], "holding steps down every 150 ms after 400 ms");
  const at = sent.slice(1).map(([, , t0]) => t0);
  t.ok(at.every((t0, i) => i === 0 || t0 - at[i - 1] >= 100), "never more than one request per 100 ms");
  c2.advance(1000);
  t.equal(sent.length, 5, "nothing is sent after release");
  level = 98;
  stepper.press(1); c2.advance(400); c2.advance(150); stepper.release();
  t.deepEqual(sent.slice(5).map(([v]) => v), [100], "at 100 a held button stops sending");
  const c3 = fakeClock();
  const sent3 = [];
  const fast = createVolumeStepper({ ...c3, intervalMs: 40, getLevel: () => 50, send: (v, final) => sent3.push([v, final, c3.now()]) });
  fast.press(1); c3.advance(400 + 40 + 20); fast.release();
  t.ok(sent3.at(-1)[1] === true && sent3.at(-1)[0] === 65, "a value still waiting in the throttle goes out as the final value on release");
  const nullStep = createVolumeStepper({ ...fakeClock(), getLevel: () => null, send: () => sent3.push("x") });
  const before = sent3.length; nullStep.press(1); nullStep.release();
  t.equal(sent3.length, before, "an unknown level sends nothing");
}

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

// Flicker fix: every transport surface goes through the poller's ordered command path.
t.ok(appJs.includes("await mediaPoller.command(() => api(\"/api/media\"") || appJs.includes('const fresh = await mediaPoller.command(() => api("/api/media"'), "media commands run through the poller so stale polls are discarded");
t.ok(appJs.includes("if (transport && mediaCaps(caps()).available && !usesLegacyMedia()) return mediaCommand(transport);"), "the pinned Play/Pause tile shares the mini player's state and command path");
t.ok(appJs.includes("syncPinnedPlay(before);"), "the pinned tile glyph follows optimistic changes too");
// ---- Spotify account, Phase B (DOCK-CONTROLS 6.4, 12, 13) ----
{
  const F = (account, extra = {}) => ({ spotify: { installed: true, local: {}, account }, ...extra });
  const spMedia = normalizeMedia({ source: { id: "spotify", name: "Spotify", appId: "com.spotify.client" }, title: "Houdini", artist: "Dua Lipa", playing: true });
  const chrome = normalizeMedia({ source: { id: "chrome", name: "Chrome" }, title: "Video", playing: true });

  // Visibility (6.4): everything hides without an available account.
  t.equal(spotifyAccount(undefined), null, "no features: no Spotify account surface");
  t.equal(spotifyAccount({ spotify: { installed: true, local: {} } }), null, "Phase A host (no account key): hidden");
  t.equal(spotifyAccount(F({ available: false })), null, "available false: hidden");
  t.deepEqual(spotifyAccount(F({ available: true, connected: true, premium: null, name: "Geri" })), { available: true, connected: true, premium: true, name: "Geri" }, "premium null (unknown) reads as allowed");
  t.equal(spotifyAccount(F({ available: true, connected: true, premium: false })).premium, false, "only an explicit false is non-Premium");
  t.equal(spotifyMode({ account: null, media: spMedia, installed: true }), "hidden", "mode hidden without an account");
  t.equal(spotifyMode({ account: spotifyAccount(F({ available: true, connected: false })), media: spMedia }), "entry", "not connected + Spotify source: entry row");
  t.equal(spotifyMode({ account: spotifyAccount(F({ available: true, connected: false })), media: chrome, installed: false }), "hidden", "not connected, other source, Spotify not installed: hidden");
  t.equal(spotifyMode({ account: spotifyAccount(F({ available: true, connected: false })), media: null, installed: true }), "entry", "Spotify installed: entry row even with nothing playing");
  t.equal(spotifyMode({ account: spotifyAccount(F({ available: true, connected: false })), media: spMedia, waiting: true }), "waiting", "connect pressed: waiting");
  t.equal(spotifyMode({ account: spotifyAccount(F({ available: true, connected: true })), media: chrome }), "tabs", "connected: tabs whatever the source");
  t.equal(spotifyMode({ account: spotifyAccount(F({ available: true, connected: true })), media: chrome, disconnected: true }), "entry", "revoked token: back to the entry row");
  t.ok(spotifyInstalled({ media: { players: [{ id: "spotify", installed: true }] } }) && !spotifyInstalled({}), "installed from the player list too");
  t.ok(isSpotifySource(spMedia) && !isSpotifySource(chrome) && !isSpotifySource(null), "Spotify source detection");

  // Tabs: roles, selection, roving tabindex, offline greys them.
  const tabs = renderSpTabs({ tab: "library" });
  t.ok(tabs.includes('role="tablist"') && (tabs.match(/role="tab"/g) || []).length === 4, "a tablist with four tabs");
  t.ok(tabs.includes('id="sp-tab-library" data-sp-tab="library" aria-selected="true" aria-controls="sp-tabpanel" tabindex="0"'), "the current tab is selected and focusable");
  t.ok(tabs.includes('data-sp-tab="now" aria-selected="false" aria-controls="sp-tabpanel" tabindex="-1"'), "other tabs leave the tab order");
  t.deepEqual(SP_TABS.map((x) => x.label), ["Now playing", "Library", "Search", "Devices"], "sp.tabs copy");
  t.equal((renderSpTabs({ tab: "now", online: false }).match(/ disabled>/g) || []).length, 4, "offline: every tab is disabled");
  t.equal(spotifyTab("bogus"), "now", "unknown tab falls back to Now playing");
  t.deepEqual(["ArrowRight", "ArrowLeft", "Home", "End", "x"].map((k) => nextTab("now", k)), ["library", "devices", "now", "devices", null], "arrow keys, Home and End move between tabs");

  // Header with tabs (frames 21, 22) and the heart (Now playing).
  const tabbed = renderMediaSheet({ media: spMedia, caps: mediaCaps({ features: { media: { sources: "system" } } }), online: true, computer: "Studio PC", tabs, brand: spotifyBrand(), like: renderLikeButton({ liked: true }) });
  t.ok(tabbed.includes('<header class="media-head has-tabs">') && tabbed.includes(tabs), "tabs sit in the sheet header");
  t.ok(!tabbed.includes("on Studio PC"), "with tabs the source drops its \"on {computer}\" context");
  t.ok(tabbed.includes('id="sp-tabpanel" role="tabpanel" aria-labelledby="sp-tab-now"'), "the Now playing body is the tab panel");
  t.ok(tabbed.includes('class="media-title-row"') && tabbed.includes('data-sp-like aria-label="Like" aria-pressed="true"'), "the heart sits next to the title, pressed when liked");
  t.ok(renderLikeButton({ liked: false, online: false }).includes('aria-pressed="false" disabled'), "heart: not liked, offline disabled");
  const other = renderMediaSheet({ media: spMedia, online: true, computer: "Studio PC", tabs, brand: spotifyBrand(), body: "" });
  t.ok(other.includes('<span class="media-source__name">Spotify</span>') && !other.includes("media-body"), "another tab: Spotify brand, no player body");
  t.ok(!other.includes("Show on"), "Show on {Mac/PC} only on Now playing");
  const offlineHead = renderMediaSheet({ media: spMedia, online: false, computer: "Studio PC", tabs, brand: spotifyBrand(), body: "" });
  t.ok(offlineHead.includes("Reconnecting to Studio PC…"), "offline: the header says it is reconnecting");
  const phaseA = renderMediaSheet({ media: spMedia, online: true, computer: "Studio PC" });
  t.ok(!phaseA.includes("sp-tabpanel") && phaseA.includes("<small>on Studio PC</small>"), "without tabs the Phase A sheet is unchanged");

  // Entry row, waiting view (frame 20) and copy (13).
  const entry = renderSpEntry();
  t.ok(entry.includes("Your playlists, search and devices") && entry.includes(">Connect Spotify</button>"), "entry row copy");
  const again = renderSpEntry({ disconnected: true, online: false });
  t.ok(again.includes("Spotify disconnected") && again.includes("Connect again") && again.includes("data-sp-connect disabled"), "revoked token: Spotify disconnected · Connect again (offline disabled)");
  const waiting = renderSpWaiting({ computer: "Studio PC" });
  t.ok(waiting.includes("<h3>Finish on Studio PC</h3>") && waiting.includes("A browser window opened on Studio PC. Log in to Spotify there and allow WinDock. Your password never passes through this phone."), "waiting: title and body");
  t.ok(waiting.includes('role="status"><span class="spinner" aria-hidden="true"></span>Waiting for Spotify…'), "waiting: spinner and status text");
  t.ok(waiting.includes("Open the window again") && waiting.includes(">Cancel</button>") && waiting.includes("Playing from your library needs Spotify Premium."), "waiting: actions and the after-note");
  t.ok(renderSpWaiting({ stopped: true }).includes('class="spinner is-stopped"'), "the spinner stops after 60 s; the words stay");
  t.equal(WAIT_STOP_MS, 60_000, "waiting spinner stops at 60 s");

  // Host data shapes (src/spotify/contract.js mappers).
  const page1 = normalizePage({ items: [
    { id: "a".repeat(22), uri: "spotify:playlist:" + "a".repeat(22), name: "Shqip të vjetra", owner: { id: "geri", name: "Geri" }, tracks: 212, image: "0123456789abcdef0123456789abcdef" },
    { id: "b".repeat(22), uri: "spotify:playlist:" + "b".repeat(22), name: "Discover Weekly", owner: { id: "spotify", name: null }, tracks: null, image: null },
    { uri: "https://evil.example/x", name: "Bad" },
  ], total: 3, offset: 0, limit: 2, next: true }, "playlist", 0);
  t.equal(page1.items.length, 2, "malformed items are dropped");
  t.equal(page1.next, 3, "next: true → the next offset");
  t.equal(normalizePage({ items: [], next: false }, "playlist", 40).next, null, "next: false → the end");
  t.equal(page1.items[0].owner, "Geri", "owner object → name");
  const merged = mergePage(mergePage(null, page1), { items: [page1.items[1]], next: null });
  t.equal(merged.items.length, 2, "paging drops duplicates");
  t.equal(merged.next, null, "the last page ends paging");
  const search = normalizeSearch({ q: "dua", tracks: { items: [{ type: "track", id: "c".repeat(22), uri: "spotify:track:" + "c".repeat(22), name: "Houdini", artists: [{ id: null, uri: null, name: "Dua Lipa" }, { name: "DaBaby" }], album: { id: null, name: "Radical Optimism" }, image: null }] }, artists: { items: [] } });
  t.equal(search.tracks[0].artists, "Dua Lipa, DaBaby", "artists arrays of objects join with \", \"");
  t.equal(search.tracks[0].album, "Radical Optimism", "album object → name");
  t.deepEqual([search.albums.length, search.playlists.length], [0, 0], "missing sections are empty");
  t.equal(normalizeQueue({ currentlyPlaying: null, queue: [{ type: "track", id: "d".repeat(22), uri: "spotify:track:" + "d".repeat(22), name: "Illusion", artists: [{ name: "Dua Lipa" }] }] }).length, 1, "queue reads { queue }");
  const devices = normalizeDevices({ devices: [{ id: "abc", name: "Studio PC", type: "Computer", active: true }, { id: null, name: "Restricted TV", type: "TV", active: false }, { id: "s1", name: "Sonos", type: "Speaker", active: false, restricted: true }] });
  t.deepEqual(devices.map((d) => [d.id, d.restricted]), [["abc", false], [null, true], ["s1", true]], "devices without an id or restricted can't take playback");
  const status = normalizeSpotifyStatus({ configured: true, connected: true, premium: null, playback: { device: { id: "abc", name: "Studio PC", type: "Computer", active: true }, playing: true, item: { type: "track", id: "4OMJGnvZfDvsePyCwRGO7X", uri: "spotify:track:4OMJGnvZfDvsePyCwRGO7X", name: "Houdini", artists: [{ name: "Dua Lipa" }], image: null }, context: { type: "playlist", uri: "spotify:playlist:" + "a".repeat(22) } } });
  t.deepEqual([status.track.id, status.playing, status.contextUri, status.device.name], ["4OMJGnvZfDvsePyCwRGO7X", true, "spotify:playlist:" + "a".repeat(22), "Studio PC"], "status.playback maps to track, playing, context, device");
  t.equal(normalizeSpotifyStatus({ playback: null }).track, null, "nothing playing: no track (heart hidden)");
  t.ok(isLikedContext("spotify:user:geri:collection") && isLikedContext(LIKED_CONTEXT) && !isLikedContext("spotify:playlist:x"), "Liked Songs context detection");
  t.equal(spotifyImageUrl("0123456789abcdef0123456789abcdef"), "/api/spotify/image?key=0123456789abcdef0123456789abcdef", "image keys go through the host route");
  for (const bad of ["https://i.scdn.co/image/x", "//evil", "/api/x", "javascript:alert(1)", "a b", "", null]) t.equal(spotifyImageUrl(bad), null, `never an image URL from data: ${bad}`);

  // What a tap plays.
  t.deepEqual(playBody({ kind: "track", uri: "spotify:track:" + "c".repeat(22) }), { uri: "spotify:track:" + "c".repeat(22) }, "a song plays by uri");
  t.deepEqual(playBody({ kind: "playlist", uri: "spotify:playlist:" + "a".repeat(22) }), { contextUri: "spotify:playlist:" + "a".repeat(22) }, "a playlist plays as a context");
  t.deepEqual(playBody({ kind: "liked", uri: LIKED_CONTEXT, firstUri: "spotify:track:" + "c".repeat(22) }), { uri: "spotify:track:" + "c".repeat(22) }, "Liked Songs starts the newest liked song");
  t.equal(playBody({ kind: "liked", uri: LIKED_CONTEXT }), null, "Liked Songs before its first song is known: nothing");

  // Library (frame 21): Liked first, two columns, playing row, paging, Premium.
  const pl = page1.items;
  const lib = renderSpLibrary({ likedTotal: 1284, playlists: mergePage(null, { ...page1, next: 30 }), playingUri: pl[0].uri });
  t.ok(lib.includes('role="tabpanel" aria-labelledby="sp-tab-library"') && lib.includes('<ul class="sp-list" aria-label="Your library">'), "library: a tab panel with a list");
  t.ok(lib.indexOf("Liked Songs") < lib.indexOf("Shqip të vjetra"), "Liked Songs comes first");
  t.ok(lib.includes("1,284 songs"), "Liked Songs count: 1,284 songs");
  t.ok(lib.includes("Playlist · Geri · 212 songs"), "playlist subtitle: Playlist · owner · count");
  t.ok(/is-playing" type="button" data-sp-uri="spotify:playlist:a{22}"[^>]*aria-current="true"/.test(lib) && lib.includes('<span class="sp-row__playing">'), "the playing row shows Playing with the speaker");
  t.equal((lib.match(/sp-row__playing/g) || []).length, 1, "only one row is playing");
  t.ok(lib.includes('src="/api/spotify/image?key=0123456789abcdef0123456789abcdef"'), "covers load through the image route");
  t.ok(lib.includes("data-sp-more"), "more pages: a paging sentinel");
  t.ok(!renderSpLibrary({ playlists: merged }).includes("data-sp-more"), "last page: no sentinel");
  t.ok(renderSpLibrary({ playlists: null }).includes("Loading your library…"), "first load: loading line");
  t.ok(renderSpLibrary({ playlists: { items: pl, next: 30, loading: true, loaded: true } }).includes("Loading more…"), "next page: loading more");
  const libErr = renderSpLibrary({ playlists: { items: [], next: 0, loading: false, loaded: false, error: SP_COPY.busy } });
  t.ok(libErr.includes("Spotify is busy, try again in a moment") && libErr.includes('data-sp-retry="library"'), "library error with Try again");
  t.ok(renderSpLibrary({ likedTotal: 0, playlists: { items: [], next: null, loaded: true } }).includes("0 songs"), "empty library: Liked Songs still listed");
  const locked = renderSpLibrary({ playlists: mergePage(null, page1), premium: false });
  t.ok(locked.includes("Needs Spotify Premium"), "not Premium: the note");
  t.equal((locked.match(/aria-disabled="true"/g) || []).length, 3, "not Premium: every row stays readable but disabled");
  t.ok(!locked.includes("sp-row__tail"), "not Premium: no play glyphs");
  t.ok(renderSpLibrary({ playlists: mergePage(null, page1), online: false }).includes(" disabled>"), "offline: rows disabled");

  // Search: field, sections, empty, error.
  const panel = renderSpSearchPanel();
  t.ok(panel.includes('type="search" data-sp-search placeholder="Songs, artists, albums" aria-label="Search Spotify"') && panel.includes("data-sp-results"), "search field with its placeholder, results under it");
  t.equal(renderSpResults({ query: "" }), "", "no query: no results");
  t.ok(renderSpResults({ query: "du", loading: true }).includes("Searching…"), "first search: searching line");
  t.equal(renderSpResults({ query: "zzz", results: normalizeSearch({}) }), '<p class="sp-status" role="status">No results for &quot;zzz&quot;.</p>', "no results copy (quotes escaped)");
  const full = normalizeSearch({ tracks: { items: [{ id: "c".repeat(22), name: "Houdini", artists: [{ name: "Dua Lipa" }] }] }, artists: { items: [{ id: "e".repeat(22), name: "Dua Lipa" }] }, albums: { items: [{ id: "f".repeat(22), name: "Radical Optimism", artists: [{ name: "Dua Lipa" }] }] }, playlists: { items: [{ id: "g".repeat(22), name: "This Is Dua Lipa", owner: { name: "Spotify" } }] } });
  const res = renderSpResults({ query: "dua", results: full });
  t.deepEqual([...res.matchAll(/<h3 class="sp-label">([^<]+)</g)].map((m) => m[1]), ["Songs", "Artists", "Albums", "Playlists"], "sections in order");
  t.ok(res.includes("sp-row--compact") && res.includes("sp-art--round"), "rows 56; artists round");
  t.ok(res.includes('data-sp-kind="track"') && res.includes('data-sp-kind="album"'), "rows carry their kind for tap / long-press");
  t.ok(renderSpResults({ query: "dua", error: "Spotify is busy, try again in a moment" }).includes('data-sp-retry="search"'), "search error with Try again");
  t.ok((renderSpResults({ query: "dua", results: full, premium: false }).match(/aria-disabled="true"/g) || []).length === 4, "not Premium: results readable, play disabled");

  // Devices (frame 22).
  const dev = renderSpDevices({ devices: normalizeDevices({ devices: [{ id: "d1", name: "Studio PC", type: "Computer", active: true }, { id: "d2", name: "Sonos Kuzhina", type: "Speaker" }, { id: "d3", name: "Geri's iPhone", type: "Smartphone" }] }), hostName: "Studio PC", playing: true });
  t.ok(dev.includes('<h3 class="sp-label" id="sp-devices-label">Play on</h3>') && dev.includes('aria-labelledby="sp-devices-label"'), "devices: Play on, labelled list");
  t.ok(dev.includes("This computer · Playing") && dev.includes(">Speaker<") && dev.includes(">Phone<"), "device subtitles (frame 22)");
  t.ok(/is-active" type="button" data-sp-device="d1" aria-current="true"/.test(dev) && dev.includes("sp-row__check"), "the current device is checked");
  t.ok(dev.includes("Only devices with Spotify open show up. Switching needs Spotify Premium."), "devices note");
  t.ok(dev.includes(">Disconnect Spotify</button>"), "Disconnect Spotify row at the bottom");
  const devLocked = renderSpDevices({ devices: normalizeDevices({ devices: [{ id: "d1", name: "A", type: "Computer", active: true }, { id: "d2", name: "B", type: "Speaker" }] }), premium: false });
  t.ok(devLocked.includes("Needs Spotify Premium") && devLocked.includes('data-sp-device="d2" aria-disabled="true"') && !/data-sp-device="d1"[^>]*aria-disabled/.test(devLocked), "not Premium: switching disabled, the list readable");
  t.ok(renderSpDevices({ devices: [], loading: true }).includes("Looking for devices…"), "devices loading");
  t.deepEqual(["Computer", "Smartphone", "Speaker", "TV", "AVR"].map(deviceIcon), ["monitor", "phone", "speaker", "monitor", "speaker"], "device glyphs");
  t.equal(deviceSubtitle({ name: "Mac", type: "Computer", active: false }, { hostName: "Studio PC" }), "Computer", "another computer reads Computer");

  // Footer on every tab.
  const foot = renderSpFooter({ track: { title: "Houdini", artist: "Dua Lipa", artwork: "/api/media/artwork?key=1" }, playing: true, canPlay: true, device: { name: "Studio PC", type: "Computer" } });
  t.ok(foot.includes("<strong>Houdini</strong> · Dua Lipa") && foot.includes('data-media="pause" aria-label="Pause"'), "footer: track and Pause");
  t.ok(foot.includes('data-sp-goto="devices" aria-label="Playing on Studio PC. Choose a device."'), "footer: device chip opens Devices");
  t.ok(renderSpFooter({}).includes("Nothing playing") && renderSpFooter({}).includes('aria-label="Play" disabled'), "footer with nothing playing");
  t.ok(renderSpUpNext([]) === "" && renderSpUpNext(normalizeQueue({ queue: Array.from({ length: 7 }, (_, i) => ({ id: String(i).repeat(22), name: "T" + i })) })).match(/<li>/g).length === 5, "Up next: at most five, absent when empty");

  // Up next on narrower screens: a button in Now playing opens a queue panel (see + add only).
  {
    const on = { mode: "tabs", supported: true, wide: false, spotifyNow: true };
    t.deepEqual(upNextButton({ ...on, loaded: true, count: 8 }), { label: "Up next · 8" }, "Up next button: label with the count");
    t.deepEqual(upNextButton({ ...on, loaded: false }), { label: "Up next" }, "Up next button: no count while loading");
    t.equal(upNextButton({ ...on, supported: false, loaded: true, count: 3 }), null, "Up next button hidden when the queue route 404s");
    t.equal(upNextButton({ ...on, mode: "entry" }), null, "Up next button hidden when Spotify isn't connected (entry row)");
    t.equal(upNextButton({ ...on, mode: "hidden" }), null, "Up next button hidden without a Spotify account");
    t.equal(upNextButton({ ...on, wide: true }), null, "wide screens keep the side list instead of the button");
    t.equal(upNextButton({ ...on, spotifyNow: false }), null, "Up next button hidden when Spotify isn't the source");
    t.deepEqual(upNextButton({ ...on, loaded: true, count: 0 }), { label: "Up next · 0" }, "an empty queue still opens the panel (empty state)");
    t.equal(UP_NEXT_WIDE_MIN, 1000, "the side list starts at 1000 px");
    t.equal(renderUpNextButton(null), "", "hidden button renders nothing");
    const btn = renderUpNextButton({ label: "Up next · 8" });
    t.ok(btn.includes('class="media-link sp-upnext-button" type="button" data-sp-queue-open>Up next · 8</button>'), "the button uses the sheet's chip style");
    t.ok(renderUpNextButton({ label: "Up next" }, { online: false }).includes("data-sp-queue-open disabled"), "offline: the button is disabled");
    const withBtn = renderMediaSheet({ media: spMedia, online: true, computer: "Studio PC", tabs, brand: spotifyBrand(), upNext: btn });
    t.ok(withBtn.includes('<div class="media-meta"><div class="media-meta__text"><p class="media-artist">Dua Lipa</p></div><button class="media-link sp-upnext-button"'), "Now playing: the button sits beside the artist line (no extra row)");
    t.ok(!renderMediaSheet({ media: spMedia, online: true, computer: "Studio PC", tabs, brand: spotifyBrand() }).includes("media-meta"), "without the button the player markup is unchanged");

    const raw = { currentlyPlaying: null, queue: [
      { type: "track", id: "d".repeat(22), uri: "spotify:track:" + "d".repeat(22), name: "Illusion", artists: [{ name: "Dua Lipa" }], durationMs: 188000, image: "0123456789abcdef0123456789abcdef" },
      { type: "track", id: "e".repeat(22), uri: "spotify:track:" + "e".repeat(22), name: "Kënga <ime>", artists: [{ name: "Elvana Gjata" }, { name: "Ledri Vula" }], durationMs: 196000, image: null },
      { type: "episode", id: "f".repeat(22), uri: "spotify:episode:" + "f".repeat(22), name: "Ep. 12", show: "The Pod", durationMs: 3600000, image: null },
      { type: "track", uri: "spotify:local:x:y:z:1", name: "Local file" },
    ] };
    const q = normalizeQueue(raw);
    t.equal(q.length, 3, "queue: malformed and local items dropped");
    t.equal(q[1].artists, "Elvana Gjata, Ledri Vula", "queue: artist arrays joined");
    t.equal(q[2].artists, "The Pod", "queue: an episode names its show");
    t.equal(normalizeQueue({ items: raw.queue }).length, 3, "queue also reads { items }");
    t.deepEqual([formatDuration(188000), formatDuration(3600000), formatDuration(5000), formatDuration(null)], ["3:08", "60:00", "0:05", ""], "durations m:ss");

    const qp = renderSpQueuePanel({ items: q, loaded: true });
    t.ok(qp.includes('role="tabpanel" aria-labelledby="sp-tab-now"') && qp.includes('<h3 class="sp-queue__title" id="sp-queue-title">Up next</h3>'), "queue panel: inside Now playing, with a heading");
    t.ok(qp.includes('<ol class="sp-queue__list" aria-labelledby="sp-queue-title">') && (qp.match(/<li class="sp-queue__row">/g) || []).length === 3, "queue panel: an ordered list, one item per song");
    t.ok(qp.includes('data-sp-queue-back><svg') && qp.includes("<span>Now playing</span></button>"), "queue panel: back arrow labelled Now playing");
    t.ok(qp.includes("data-sp-add-songs") && qp.includes("<span>Add songs</span>"), "queue panel: Add songs in the header");
    t.equal((qp.match(/sp-queue__next/g) || []).length, 1, "only the first row is labelled Next");
    t.ok(qp.indexOf("sp-queue__next") < qp.indexOf("Illusion") && qp.indexOf("Illusion") < qp.indexOf("Kënga"), "Next labels the first row; order kept");
    t.ok(qp.includes('<span class="sp-queue__time">3:08</span>') && qp.includes("Elvana Gjata, Ledri Vula") && qp.includes("Kënga &lt;ime&gt;"), "rows: duration, artists, escaped title");
    t.ok(qp.includes('src="/api/spotify/image?key=0123456789abcdef0123456789abcdef"'), "rows: artwork through the image route");
    const rowsOnly = qp.slice(qp.indexOf("<ol"));
    t.ok(!rowsOnly.includes("<button") && !rowsOnly.includes("data-sp-uri") && !rowsOnly.includes("draggable"), "rows are informational: no buttons, no tap action, no drag or remove");
    const empty = renderSpQueuePanel({ items: [], loaded: true });
    t.ok(empty.includes("Nothing queued. Long-press a song in Search or Library to add it.") && (empty.match(/data-sp-add-songs/g) || []).length === 2, "empty state: the copy and Add songs");
    t.ok(renderSpQueuePanel({ items: [], loaded: false }).includes("Loading the queue…"), "first load: loading line");
    const errPanel = renderSpQueuePanel({ items: [], loaded: false, error: "Spotify is busy, try again in a moment" });
    t.ok(errPanel.includes("Spotify is busy, try again in a moment") && errPanel.includes('data-sp-retry="queue">Try again</button>') && !errPanel.includes("Loading the queue"), "error/429: short message with Try again");
    t.ok(renderSpQueuePanel({ items: q, loaded: true, error: "Couldn't load the queue." }).includes('<li class="sp-queue__row">'), "a failed refresh keeps the list on screen");
    t.ok(renderSpQueuePanel({ items: q, loaded: true, online: false }).includes("data-sp-add-songs disabled"), "offline: Add songs disabled");

    // Back order: panel first, then the sheet.
    t.equal(mediaBackStep({ queueOpen: true }), "queue", "Back with the queue panel open returns to Now playing");
    t.equal(mediaBackStep({ queueOpen: false }), "sheet", "Back from Now playing closes the sheet");

    // The loader: single-flight, stale answers ignored, 15 s refresh while visible.
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const clock = fakeClock();
    const loads = [], states = [];
    let polling = true;
    const loader = createQueueLoader({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, isPolling: () => polling, onState: (st) => states.push(st),
      load: () => new Promise((resolve, reject) => loads.push({ resolve, reject })) });
    const answer = (n) => ({ queue: Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(97 + i).repeat(22), name: "T" + i })) });
    loader.refresh(); loader.refresh();
    await flush();
    t.equal(loads.length, 1, "queue loader is single-flight");
    loads[0].resolve(answer(2)); await flush();
    t.equal(states.at(-1).items.length, 2, "an answer lands");
    loader.refresh(); await flush();
    loader.refresh({ invalidate: true }); await flush();
    t.equal(loads.length, 2, "a track change while a request is in flight waits for it");
    loads[1].resolve(answer(5)); await flush(); await flush();
    t.ok(!states.some((st) => st.items?.length === 5), "the stale answer (started before the track change) is ignored");
    t.equal(loads.length, 3, "then the queue is asked again");
    loads[2].resolve(answer(3)); await flush();
    t.equal(states.at(-1).items.length, 3, "the fresh answer lands");
    loader.poll(true);
    clock.advance(QUEUE_REFRESH_MS - 1); await flush();
    t.equal(loads.length, 3, "no refresh before 15 s");
    clock.advance(1); await flush();
    t.equal(loads.length, 4, "refresh every 15 s while the panel is visible");
    loads[3].resolve(answer(3)); await flush();
    polling = false; clock.advance(QUEUE_REFRESH_MS); await flush();
    t.equal(loads.length, 4, "no refresh while hidden or offline");
    polling = true; clock.advance(QUEUE_REFRESH_MS); await flush();
    t.equal(loads.length, 5, "the rhythm resumes when visible again");
    loads[4].resolve(answer(3)); await flush();
    loader.poll(false); clock.advance(QUEUE_REFRESH_MS * 3); await flush();
    t.equal(loads.length, 5, "closing the panel stops the refresh");
    loader.refresh(); await flush();
    loads[5].reject(Object.assign(new Error("not found"), { status: 404 })); await flush();
    t.deepEqual([states.at(-1).unsupported, states.at(-1).error?.status], [true, 404], "a 404 marks the queue route unsupported");
    loader.refresh(); await flush();
    loads[6].reject(Object.assign(new Error("rate limited"), { status: 429, detail: "rate limited" })); await flush();
    t.deepEqual([states.at(-1).unsupported, states.at(-1).error?.status], [false, 429], "a 429 is an error, not unsupported");
    loader.refresh(); await flush(); loader.cancel();
    loads[7].resolve(answer(9)); await flush();
    t.ok(!states.some((st) => st.items?.length === 9), "cancel (account gone) discards the answer in flight");
    t.equal(QUEUE_REFRESH_MS, 15_000, "queue refresh every 15 s");

    // Wiring in app.js.
    t.ok(appJs.includes("$(\"media\").close = function close(value) {") && appJs.includes('mediaBackStep({ queueOpen: sp.queueOpen && this.open }) === "queue") return spCloseQueue();'), "Android Back (close() on the top dialog) leaves the queue panel first");
    t.ok(appJs.includes('$("media").addEventListener("cancel", (event) => {') && appJs.includes('if (event.key !== "Escape" || mediaBackStep({ queueOpen: sp.queueOpen }) !== "queue"'), "Escape leaves the queue panel first");
    t.ok(appJs.includes("function closeDialog(dialog, value) { HTMLDialogElement.prototype.close.call(dialog, value); }") && appJs.includes("if (close) closeDialog($(close.dataset.close));") && appJs.includes('$("media-grip").addEventListener("click", () => closeDialog($("media")));'), "the ×, the grip and a tap outside close the sheet outright");
    t.ok(appJs.includes('spLoadStatus(); spLoadQueue({ invalidate: true }); }'), "a track change refreshes the queue (older answers dropped)");
    t.ok(/notify\(SP_COPY\.queued\);\s*spLoadQueue\(\{ invalidate: true \}\);/.test(appJs), "an add-to-queue refreshes the queue");
    t.ok(appJs.includes("spLoadQueue();\n  spQueueLoader.poll(true);") && appJs.includes('isPolling: () => sp.queueOpen && $("media").open && !document.hidden && online'), "opening the panel fetches and starts the 15 s refresh while it is visible");
    t.ok(appJs.includes('$("sp-panel").querySelector("[data-sp-queue-back]")?.focus(') && appJs.includes('$("media-content").querySelector("[data-sp-queue-open]")?.focus('), "focus: back button on open, Up next button on close");
    t.ok(appJs.includes('else if ("spAddSongs" in data) spSelectTab("search", { focus: "search" });'), "Add songs opens Search with the field focused");
    t.ok(appJs.includes("const spWide = () => window.innerWidth >= UP_NEXT_WIDE_MIN;"), "one breakpoint for the side list and the button");
    t.ok(/\.sp-queue\.is-entering \{ animation: sp-queue-in/.test(css) && css.includes("@media (prefers-reduced-motion: reduce) { .sp-queue.is-entering { animation: none; } }"), "the swap eases in, and not with reduced motion");
    t.ok(/\.sp-queue__list \{[^}]*overflow-y: auto/.test(css) && css.includes(".media-sheet.is-queue { overflow: hidden; }"), "the list scrolls inside the panel");
    t.ok(Number(/windock-v(\d+)-/.exec(read("sw.js"))?.[1]) >= 22, "the service worker cache version is bumped for Up next");
  }

  // Errors: the JSON error string decides (src/spotify/routes.js, account.js).
  const err = (status, detail, message = detail) => Object.assign(new Error(message), { status, detail });
  t.deepEqual(spotifyError(err(403, "premium required")), { kind: "premium", message: "Needs Spotify Premium" }, "403 premium required");
  t.equal(spotifyError(err(429, "rate limited")).message, "Spotify is busy, try again in a moment", "429 busy");
  t.equal(spotifyError(err(409, "no active device")).kind, "device", "409 no active device");
  t.equal(spotifyError(err(409, "spotify not connected"), "Studio PC").kind, "not-connected", "409 spotify not connected → connect state, not the device message");
  t.equal(spotifyError(err(409, "spotify disconnected")).kind, "disconnected", "409 spotify disconnected → disconnected footer");
  t.equal(spotifyError(err(403, "spotify user not allowed")).kind, "error", "403 user not allowed is not the Premium state");
  t.equal(spotifyError(err(409, "permission needed")).kind, "error", "an unrelated 409 is not the no-device message");
  t.equal(spotifyError(Object.assign(new Error("Failed to fetch"), {})).message, "Connection lost. Check that WinDock is running on your computer.", "network failure");

  // Search: 300 ms debounce, stale requests aborted and ignored.
  {
    const clock = fakeClock();
    const calls = [], states = [], resolvers = [];
    class Ctl { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } }
    const s = createSearch({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, Controller: Ctl, onState: (st) => states.push(st),
      load: (q, signal) => { calls.push({ q, signal }); return new Promise((resolve) => resolvers.push({ q, resolve })); } });
    s.input("d"); clock.advance(100); s.input("du"); clock.advance(299);
    t.equal(calls.length, 0, "nothing is sent within 300 ms of a keystroke");
    clock.advance(1);
    t.deepEqual(calls.map((c) => c.q), ["du"], "one request 300 ms after the last keystroke");
    s.input("dua"); clock.advance(300);
    t.ok(calls[0].signal.aborted, "a newer query aborts the request in flight");
    t.deepEqual(calls.map((c) => c.q), ["du", "dua"], "then asks for the newer query");
    resolvers[1].resolve({ tracks: { items: [{ id: "c".repeat(22), name: "Houdini" }] } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    resolvers[0].resolve({ tracks: { items: [{ id: "h".repeat(22), name: "Stale" }] } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const shown = states.filter((st) => "results" in st && st.results);
    t.equal(shown.length, 1, "only one answer is shown");
    t.equal(shown[0].results.tracks[0].name, "Houdini", "the stale answer never replaces the newer one");
    t.ok(states.some((st) => st.loading && !("results" in st)), "while typing the previous results stay (no results key)");
    s.input(""); t.deepEqual(states.at(-1), { query: "", results: null, loading: false, error: null }, "clearing the field clears the results");
    s.input("x"); s.flush();
    t.equal(calls.at(-1).q, "x", "Enter searches at once");
    t.equal(SEARCH_DEBOUNCE_MS, 300, "debounce is 300 ms");
  }

  // Long-press menu actions and the playlist tile.
  t.deepEqual(spotifyMenuActions({ kind: "playlist", uri: "spotify:playlist:" + "a".repeat(22) }).map((a) => a.id), ["play", "dock"], "playlist menu: Play, Add to dock");
  t.deepEqual(spotifyMenuActions({ kind: "album", uri: "spotify:album:" + "f".repeat(22) }).map((a) => a.id), ["play", "dock"], "album menu: Play, Add to dock");
  t.deepEqual(spotifyMenuActions({ kind: "track", uri: "spotify:track:" + "c".repeat(22) }).map((a) => a.id), ["play", "queue"], "song menu: Play, Add to queue (no dock tile)");
  t.ok(renderSpMenuActions({ kind: "playlist", uri: "spotify:playlist:" + "a".repeat(22) }, { premium: false }).includes('data-sp-menu="play" disabled'), "not Premium: Play disabled, Add to dock allowed");
  t.equal(LONG_PRESS_MS, 500, "long-press is 500 ms");
  const tile = spotifyTile({ kind: "playlist", uri: "spotify:playlist:" + "a".repeat(22), name: "Shqip të vjetra", image: "0123456789abcdef0123456789abcdef" });
  t.deepEqual(tile, { kind: "spotify", uri: "spotify:playlist:" + "a".repeat(22), label: "Shqip të vjetra", image: "0123456789abcdef0123456789abcdef" }, "Add to dock builds a spotify tile");
  t.equal(spotifyTile({ kind: "track", uri: "spotify:track:" + "c".repeat(22), name: "x" }), null, "songs and artists never become tiles");
  t.equal(tileKey(tile), "spotify:spotify:playlist:" + "a".repeat(22), "tile key is per URI");
  const added = addSpotifyTile([{ kind: "app", id: "a", target: "a", label: "A" }], tile);
  t.equal(added.length, 2, "the tile is appended");
  t.deepEqual(toWireTiles(added)[1], tile, "spotify tiles survive toWireTiles (kind, uri, label, image)");
  t.equal(addSpotifyTile(added, tile).length, 2, "a duplicate is a no-op (the page says Already on your dock)");
  t.ok(hasTile(added, tileKey(tile)), "duplicates are found by key");
  t.equal(addSpotifyTile(added, { kind: "spotify", uri: "spotify:track:" + "c".repeat(22), label: "x" }).length, 2, "a non-playlist URI is refused");
  t.equal(removeTile(added, tileKey(tile)).length, 1, "removed like other tiles");
  t.deepEqual(moveTile(added, tileKey(tile), -1).map((x) => x.kind), ["spotify", "app"], "arranged like other tiles");
  t.equal(MAX_TILES, 64, "the max-tiles rule applies (64)");

  const tileHtml = renderTile({ ...tile, available: true });
  t.ok(tileHtml.includes('data-action="spotify-play" data-key="spotify:playlist:' + "a".repeat(22) + '" data-tile-key="spotify:spotify:playlist:' + "a".repeat(22) + '"'), "the tile plays its URI");
  t.ok(tileHtml.includes('class="app-icon sp-cover"') && tileHtml.includes('/api/spotify/image?key=0123456789abcdef0123456789abcdef') && tileHtml.includes('<span class="sp-badge">'), "cover through the image route with a Spotify badge");
  t.ok(tileHtml.includes('aria-label="Shqip të vjetra, Spotify"'), "tile name says Spotify");
  t.ok(!tileHtml.includes("tile__close") && !tileHtml.includes("tile-slot"), "no close button: it is not an app");
  const off = renderTile({ ...tile, available: false });
  t.ok(off.includes("is-unavailable") && off.includes("connect Spotify on this computer to play it"), "unavailable: dimmed and explained");
  t.ok(renderTile({ ...tile, label: "<b>" }).includes("&lt;b&gt;"), "tile label is escaped");
  t.ok(renderTile({ kind: "spotify", uri: tile.uri, label: "No art" }).includes("sp-cover icon-failed"), "no image: the letter fallback");
  t.ok(renderTile(tile, { editing: true }).includes('data-key="spotify:spotify:playlist:'), "arrange mode keys the tile");
  t.equal(SP_COPY.connectFirst("Studio PC"), "Connect Spotify on Studio PC to play this", "unavailable tile toast");
  t.equal(SP_COPY.playingName("Deep Focus"), "Playing Deep Focus", "tile play toast");
  t.equal(SP_COPY.queued, "Added to queue", "queue toast");
  t.equal(SP_COPY.alreadyOnDock, "Already on your dock", "duplicate toast");
  t.equal(formatCount(1284), "1,284", "counts use thousands separators");

  // Shell wiring.
  t.ok(html.includes('<div id="sp-panel" class="sp-host"></div>') && html.includes('<div id="media-spotify" class="sp-foot-host"></div>'), "the Media sheet hosts the tab panel and the footer");
  t.ok(html.includes('<dialog id="sp-menu" class="options sp-menu"'), "the long-press menu is a <dialog> (Android Back closes it)");
  const sw = read("sw.js");
  t.ok(sw.includes('"/spotify.js"') && Number(/windock-v(\d+)-/.exec(sw)?.[1]) >= 20, "spotify.js is precached and the cache version bumped");
  t.ok(readFileSync(join(import.meta.dirname, "build-website-demo.mjs"), "utf8").includes("'spotify.js'"), "the website demo copies spotify.js");
  t.ok(css.includes(".sp-tab::before { content: \"\"; position: absolute; inset: -4px 0; }"), "tabs have a 44 px hit height");
  t.ok(/\.media-sheet\.is-search \{ margin-top:/.test(css), "the sheet pins to the top while searching");
  t.ok(appJs.includes("const spSearch = createSearch(") && appJs.includes('api("/api/spotify/search?q=" + encodeURIComponent(query)'), "app.js searches through createSearch");
  t.ok(appJs.includes('api("/api/spotify/account", { method: "DELETE" })') && appJs.includes('title: "Disconnect Spotify?"'), "Disconnect Spotify asks, then calls DELETE /api/spotify/account");
  t.ok(appJs.includes('"/api/spotify/like?trackId=" + encodeURIComponent(track.id)'), "the heart reads GET /api/spotify/like");
}

// ---- empty slots: arrange the dock with gaps (an icon on page 3 while page 2 is partly empty) ----
{
  const SP = { kind: "spacer" };
  const gapped = renderTiles({ tiles: [SP, { kind: "app", id: "c:/a.exe", label: "Alpha", running: true }, SP, { kind: "control", verb: "lock", label: "Lock" }, SP] });
  t.equal((gapped.match(/<button/g) || []).length, 2, "the plain tile list skips gaps");
  t.ok(!gapped.includes("slot-empty"), "the plain tile list draws no placeholder for a gap");
  t.ok(renderTiles({ tiles: [SP, SP] }).includes("No tiles pinned"), "a dock of only gaps shows the empty state");
  t.equal(renderTile(SP), '<div class="slot-empty" aria-hidden="true"></div>', "a stray spacer renders as an inert, hidden placeholder");
  t.ok(/\.slot-empty \{[^}]*pointer-events: none/.test(css), "outside Arrange an empty slot is not a hit target");
  t.ok(/\.slot-empty\.is-editing::before \{[^}]*width: var\(--glyph\); height: var\(--glyph\)[^}]*border: 1\.5px dashed var\(--glass-border\)[^}]*border-radius: 23%/.test(css),
    "in Arrange an empty slot is an icon-sized dashed rounded outline on a theme token");
  t.ok(css.includes(".tile, .tile-slot, .slot-empty { --glyph: var(--icon-size); }") && css.includes("body.is-immersive .slot-empty,"), "an empty slot follows the icon size in every layout");
  t.ok(appJs.includes("pageCount(state.tiles, layout, editing)"), "the pager adds the extra Arrange page (paint and page dots)");
  t.ok(appJs.includes('closest("[data-tile-key], [data-empty-slot]")') && appJs.includes("dropOnSlot(state.tiles, gesture.key, Number(target.dataset.emptySlot))"), "dragging over an empty slot drops the icon exactly there");
  t.ok(appJs.includes("pageCount(state.tiles, layout, true) - 1, currentPage + direction") && appJs.includes("dropOnSlot(state.tiles, gesture.key, page * capacity"), "edge paging reaches the extra page and drops into empty slots");
  t.ok(appJs.includes('if (tile.kind === "spacer") return tile;'), "gaps carry no running, close or availability state into the view");
  t.equal((appJs.match(/realTiles\(state\.tiles\)\.length >= MAX_TILES/g) || []).length, 3, "the dock-full rule counts real tiles only (apps, controls, Spotify)");
  t.ok(Number(/windock-v(\d+)-/.exec(read("sw.js"))?.[1]) >= 21, "the service worker cache version is bumped for the gaps release");
}

t.done("pwa verification passed");
