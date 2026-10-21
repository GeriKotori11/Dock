/** G11: the PWA ships a valid manifest and its dock logic renders headlessly. */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { renderTiles, renderTile, renderNowPlaying, escapeHtml, glyphFor } from "../public/dock.js";
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

t.done("pwa verification passed");
