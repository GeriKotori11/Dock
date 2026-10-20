/** G11: the PWA ships a valid manifest and its dock logic renders headlessly. */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { renderTiles, renderTile, renderNowPlaying, escapeHtml, glyphFor } from "../public/dock.js";

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
t.ok(html2.includes('aria-label="Alpha"'), "tiles carry an accessible label");

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
for (const [id, name] of [["drawer-controls", "controls"], ["tab-controls", "controls"], ["drawer-capture", "capture"], ["drawer-input", "input"]]) {
  t.ok(appJs.includes(`$("${id}").hidden = !feature("${name}")`), `#${id} hides when the host lacks ${name}`);
}
t.ok(appJs.includes('isActive: () => paired && online && !document.hidden && feature("nowPlaying")'), "now playing polls only when the host offers it");
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
  "Your computer is disconnected. Waiting for it to reconnect.",
]) t.ok(appJs.includes(text), `app.js carries the copy: ${text}`);
for (const old of ["Windows app", '" on your PC"', "this PC", "Your PC is disconnected"]) t.ok(!appJs.includes(old), `app.js no longer says "${old}"`);
t.ok(html.includes("Enter the PIN shown by WinDock on your computer."), "the pair hint is platform neutral");
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
t.ok(appJs.includes('"Reconnecting to " + (state.hostName || "your computer") + "…"'), "the pill names the computer");
t.ok(/offlineTimer = setTimeout\(\(\) => setOffline\(!online && paired\), 1500\)/.test(appJs), "the pill waits 1.5 s and rechecks before showing");
t.ok(/function syncOffline\(\) \{\n  if \(online \|\| !paired\) return setOffline\(false\);/.test(appJs), "reconnecting or unpairing hides the pill at once");
t.ok(/function setConn\(on\) \{[\s\S]*?syncOffline\(\);\n\}/.test(appJs), "every connection change updates the pill");
t.ok(appJs.includes('$("dock").classList.toggle("is-offline", visible)'), "the dock dims with the pill");
t.ok(appJs.includes('if (!online) return notify("Your computer is disconnected. Waiting for it to reconnect.", true);'), "tapping while offline keeps the toast");
t.ok(/\.dock\.is-offline \.dock-page \{ opacity: \.55; \}/.test(css) && /\.dock-page \{ transition: opacity \.2s; \}/.test(css), "offline pages dim to .55 over 200 ms");
t.ok(/\.reconnect \{[^}]*var\(--glass-bg\)[^}]*var\(--glass-border\)/.test(css), "the pill uses the glass tokens");
t.ok(/@media \(prefers-reduced-motion: reduce\) \{ \.reconnect__dot \{ animation: none; \} \}/.test(css), "the pill's dot does not pulse with reduced motion");
t.ok(/\.dock-page--single-row \{[^}]*align-content: center/.test(css), "a single row of tiles is vertically centred");
t.ok(html.includes('id="host-name" class="bar__host">Your computer<') && html.includes('id="drawer-host">Your computer<'), "host name placeholders are platform neutral");

t.equal(glyphFor({ kind: "control", verb: "lock" }), "🔒", "control tiles get their verb glyph");
t.equal(glyphFor({ kind: "app", label: "firefox" }), "F", "app tiles fall back to an initial");
t.equal(glyphFor({ kind: "app", label: "" }), "?", "an unnamed app still gets a glyph");

t.equal(renderNowPlaying(null), "", "no now-playing renders nothing");
t.equal(renderNowPlaying({ title: "" }), "", "an empty title renders nothing");
const np = renderNowPlaying({ title: XSS, artist: "A", playing: true });
t.ok(!np.includes("<img"), "now playing escapes a hostile title");
t.ok(np.includes("&lt;img"), "the hostile title is escaped rather than dropped");

t.done("pwa verification passed");
