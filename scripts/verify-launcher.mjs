import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { normalizeLayout, renderPages, pageCount, moveToTile, dropOnSlot } from "../public/launcher.js";
import { tileKey, removeTile, moveTile, addAppTile, MAX_SLOTS } from "../public/tiles.js";
import { createIconCache } from "../src/icons.js";
import { createApp } from "../server.js";
import { createConfigStore } from "../src/config.js";
import { createWindowsProvider } from "../src/platform/windows.js";

const t = createChecker("launcher");
const layout = normalizeLayout({ perPage: 8 });
t.equal(normalizeLayout(null).perPage, 4, "new docks default to four large icons");
t.deepEqual(normalizeLayout({ columns: -1, rows: 100, iconSize: "script" }), normalizeLayout(), "invalid stored settings cannot break the grid");
for (const count of [4, 6, 8]) {
  const preference = normalizeLayout({ perPage: count });
  t.equal(preference.columns, count / 2, `${count} icons use the requested number of columns`);
  t.equal(preference.rows, 2, `${count} icons use two rows`);
}
t.ok(normalizeLayout({ perPage: 4 }).iconSize > normalizeLayout({ perPage: 6 }).iconSize && normalizeLayout({ perPage: 6 }).iconSize > layout.iconSize, "icons become smaller as density increases");
t.equal(normalizeLayout({ columns: 4, rows: 2 }).perPage, 8, "old eight-icon layouts migrate without changing capacity");
t.equal(normalizeLayout({ columns: 6, rows: 2 }).columns, 2, "old unsupported layouts reset to the spacious preset");
t.equal(normalizeLayout({ background: 'url(https://example.com)', theme: 'unknown' }).background, 'aurora', "background settings only accept bundled scenes");
const preference = normalizeLayout({ perPage: 6, immersive: false, showLabels: true, background: 'dusk', theme: 'frost' });
t.deepEqual(normalizeLayout(JSON.parse(JSON.stringify(preference))), preference, "appearance and mode preferences survive storage round trips");
t.equal(normalizeLayout().showLabels, false, "immersive mode starts without app names");
t.equal(normalizeLayout().immersive, true, "immersive mode is enabled by default");
const tiles = Array.from({ length: 17 }, (_, i) => ({ kind: "app", id: `c:/apps/${i}.exe`, target: `C:\\Apps\\${i}.exe`, label: `App ${i}` }));
t.equal(pageCount(tiles, layout), 3, "overflow creates a partially populated third page");
t.equal(pageCount([], layout), 1, "empty dock keeps one page");
const markup = renderPages({ tiles }, layout, true);
const resting = renderPages({ tiles }, layout);
t.equal((resting.match(/class="dock-page[" ]/g) || []).length, 3, "all pages render");
t.equal((markup.match(/class="dock-page[" ]/g) || []).length, 4, "Arrange adds one extra empty page");
t.equal((resting.match(/dock-page--single-row/g) || []).length, 1, "only the page with one row of tiles is centred");
t.equal((markup.match(/dock-page--single-row/g) || []).length, 0, "Arrange shows every slot, so no page collapses to one row");
for (const [count, single] of [[1, true], [layout.columns, true], [layout.columns + 1, false], [layout.columns * 2, false]]) {
  const page = renderPages({ tiles: tiles.slice(0, count) }, layout);
  t.equal(page.includes("dock-page--single-row"), single, `${count} tile(s) ${single ? "centre" : "keep"} the page layout`);
  t.equal((page.match(/data-tile-key=/g) || []).length, count, `${count} tile(s) all render`);
}
t.equal((markup.match(/data-action="options"/g) || []).length, 17, "every editing tile opens options");
t.ok(!markup.includes('data-action="launch"'), "editing tiles cannot dispatch launch");
const reordered = moveToTile(tiles, tileKey(tiles[1]), tileKey(tiles[12]));
t.equal(reordered[12].id, tiles[1].id, "dragging across pages moves to the destination");
t.equal(tiles[1].id, "c:/apps/1.exe", "a canceled drag can restore the untouched original list");
t.equal(new Set(reordered.map(tileKey)).size, 17, "cross-page moves never duplicate or drop an app");
t.deepEqual(moveToTile(tiles, "missing", tileKey(tiles[0])), tiles, "a stale drag key is ignored");

// ---- dock controls: settings and close buttons in the pager (DOCK-CONTROLS 4, 5.1) ----
t.equal(normalizeLayout().closeButtons, true, "close buttons on open apps default on");
t.equal(normalizeLayout().miniPlayer, true, "now playing on the dock defaults on");
t.equal(normalizeLayout({ closeButtons: false, miniPlayer: false }).closeButtons, false, "close buttons can be turned off");
t.equal(normalizeLayout({ closeButtons: false, miniPlayer: false }).miniPlayer, false, "the mini player can be turned off");
t.equal(normalizeLayout({ closeButtons: "no", miniPlayer: 0 }).closeButtons, true, "only an explicit false turns a switch off");
const withClose = tiles.slice(0, 8).map((tile, i) => (i % 2 ? tile : { ...tile, running: true, close: { count: 1, state: "rest" } }));
for (const perPage of [4, 6, 8]) {
  const grid = normalizeLayout({ perPage });
  const pagesHtml = renderPages({ tiles: withClose }, grid);
  t.equal((pagesHtml.match(/class="tile-slot"/g) || []).length, 4, `${perPage} per page: every running closable tile gets a slot`);
  t.equal((pagesHtml.match(/data-tile-key=/g) || []).length, 8, `${perPage} per page: every tile still renders once`);
  t.equal((pagesHtml.match(/class="tile__close"/g) || []).length, 4, `${perPage} per page: one close button per running app`);
  const firstPage = pagesHtml.split('<div class="dock-page')[1];
  const cells = firstPage.replace(/<div class="tile-slot".*?<\/button><button class="tile__close".*?<\/button><\/div>/g, "<cell>");
  t.equal((cells.match(/<cell>|<button class="tile /g) || []).length, Math.min(perPage, 8), `${perPage} per page: a slot is one grid cell`);
}
const arranging = renderPages({ tiles: withClose }, layout, true);
t.ok(!arranging.includes("tile__close") && !arranging.includes("tile-slot"), "Arrange renders no close buttons or slots");
t.deepEqual(moveToTile(withClose, tileKey(withClose[0]), tileKey(withClose[3])).map(tileKey), moveToTile(tiles.slice(0, 8), tileKey(tiles[0]), tileKey(tiles[3])).map(tileKey), "reordering is unaffected by close state");

// ---- empty slots: pages with gaps (an icon on page 3 while page 2 is partly empty) ----
const SP = { kind: "spacer" };
const ten = tiles.slice(0, 10);
const pageOf = (html, n) => html.split('<div class="dock-page').slice(1)[n] || "";
const count = (html, re) => (html.match(re) || []).length;
// Drag icon 9 (page 2) to the first slot of page 3: page 2 keeps one icon and seven gaps.
const gapped = dropOnSlot(ten, tileKey(ten[9]), 16);
t.deepEqual(gapped.map(tileKey).slice(8, 17), [tileKey(ten[8]), ...Array.from({ length: 7 }, (_, i) => `spacer:${9 + i}`), tileKey(ten[9])],
  "a drop on an empty slot past the end lands exactly there, padded with gaps, leaving a gap behind");
t.equal(pageCount(gapped, layout), 3, "page count runs to the page of the last icon");
t.equal(pageCount(gapped, layout, true), 4, "Arrange adds one extra empty page");
t.equal(pageCount(ten, layout, true), 3, "Arrange adds an extra page to a dock with no gaps too");
t.equal(pageCount([SP, SP], layout), 1, "a dock of only gaps is one (empty) page");
t.equal(pageCount([SP, SP], layout, true), 1, "an empty dock gets no extra Arrange page");
const middleEmpty = [...ten.slice(0, 8), ...Array(8).fill(SP), ten[8]];
t.equal(pageCount(middleEmpty, layout), 3, "an empty page between icons is kept");
const resting2 = renderPages({ tiles: middleEmpty }, layout);
t.equal(count(resting2, /class="dock-page[" ]/g), 3, "the empty middle page renders as a page");
t.equal(count(pageOf(resting2, 1), /data-tile-key=/g), 0, "the empty middle page holds no icons");
t.equal(count(pageOf(resting2, 2), /data-tile-key=/g), 1, "the icon after it stays on page 3");
const nearFull = [...Array(MAX_SLOTS - 8).fill(SP), ten[0]];
t.equal(pageCount(nearFull, layout, true), pageCount(nearFull, layout), "no extra Arrange page past the slot limit");

const restingGap = renderPages({ tiles: gapped }, layout);
const arrangeGap = renderPages({ tiles: gapped }, layout, true);
t.equal(count(restingGap, /class="dock-page[" ]/g), 3, "outside Arrange the gapped dock has three pages");
t.equal(count(arrangeGap, /class="dock-page[" ]/g), 4, "in Arrange it has four (the extra empty page)");
t.equal(count(pageOf(restingGap, 1), /class="slot-empty"/g), 0, "outside Arrange trailing gaps on a page render nothing");
t.ok(pageOf(restingGap, 1).includes("dock-page--single-row"), "at rest a page whose icons sit in one row is centred, even with gaps");
t.ok(pageOf(restingGap, 2).includes("dock-page--single-row"), "page 3 (gaps, then one icon) is centred at rest");
t.ok(renderPages({ tiles: [ten[0], SP, ten[1]] }, layout).includes("dock-page--single-row"), "a one-row page with a gap in the middle is centred and keeps the gap");
const cols = layout.columns;
const bottomRow = renderPages({ tiles: [...Array(cols + 1).fill(SP), ten[0]] }, layout);
t.ok(bottomRow.includes("dock-page--single-row"), "icons only in the bottom row are centred at rest");
t.equal(count(bottomRow, /class="slot-empty/g), 1, "the bottom-row icon keeps its column (one empty slot before it)");
t.ok(!renderPages({ tiles: [ten[0], ...Array(cols - 1).fill(SP), ten[1]] }, layout).includes("dock-page--single-row"), "icons in both rows keep the full grid");
t.ok(!renderPages({ tiles: [...Array(cols + 1).fill(SP), ten[0]] }, layout, true).includes("dock-page--single-row"), "Arrange always shows the full grid");
t.ok(renderPages({ tiles: ten.slice(0, 3) }, layout).includes("dock-page--single-row"), "an auto-filled single-row page (no gaps) is still centred");
t.equal(count(pageOf(restingGap, 2), /class="slot-empty"/g), 0, "the icon on page 3 sits in its first slot");
t.equal(count(pageOf(arrangeGap, 1), /class="slot-empty is-editing"/g), 7, "in Arrange page 2 shows its seven empty slots");
t.equal(count(pageOf(arrangeGap, 2), /class="slot-empty is-editing"/g), 7, "in Arrange page 3 shows the empty slots after the icon");
t.equal(count(pageOf(arrangeGap, 3), /class="slot-empty is-editing"/g), 8, "the extra page is all empty slots");
t.ok(pageOf(arrangeGap, 3).includes('data-empty-slot="24"') && pageOf(arrangeGap, 3).includes('data-empty-slot="31"'), "each empty slot names its index as a drop target");
const leadGap = renderPages({ tiles: [SP, SP, ten[0]] }, layout);
t.equal(count(leadGap, /<div class="slot-empty" aria-hidden="true"><\/div>/g), 2, "outside Arrange a gap before an icon is an invisible placeholder that keeps the grid position");
const slotsMarkup = [restingGap, arrangeGap, leadGap].join("").match(/<div class="slot-empty[^>]*><\/div>/g) || [];
t.ok(slotsMarkup.length > 0 && slotsMarkup.every((m) => m.includes('aria-hidden="true"') && !/tabindex|<button|data-tile-key|data-action/.test(m)),
  "empty slots are aria-hidden, never focusable, never buttons and never tiles");
t.equal(count(arrangeGap, /data-tile-key=/g), 10, "every icon still renders exactly once around the gaps");
t.equal(count(renderPages({ tiles: [SP, SP] }, layout), /No tiles pinned/g), 1, "a dock of only gaps shows the empty state");
t.equal(count(renderPages({ tiles: [SP, SP] }, layout, true), /No tiles pinned/g), 1, "and still does while arranging");

// Drops on an occupied slot keep the shift behaviour; on an empty one, exact placement.
t.deepEqual(dropOnSlot(gapped, tileKey(ten[0]), 3).map(tileKey), moveToTile(gapped, tileKey(ten[0]), tileKey(ten[3])).map(tileKey), "a drop on an occupied slot shifts as before");
const intoGap = dropOnSlot(gapped, tileKey(ten[0]), 12);
t.equal(tileKey(intoGap[12]), tileKey(ten[0]), "a drop on a gap in the middle lands exactly there");
t.equal(intoGap[0].kind, "spacer", "its old slot becomes a gap");
t.deepEqual(intoGap.slice(1, 8).map(tileKey), ten.slice(1, 8).map(tileKey), "no other icon moves");
t.deepEqual(dropOnSlot(gapped, tileKey(ten[0]), MAX_SLOTS).map(tileKey), gapped.map(tileKey), "a drop past the slot limit is ignored");
t.deepEqual(dropOnSlot(gapped, "app:missing", 20).map(tileKey), gapped.map(tileKey), "a stale drag key places nothing");

// Tile options on a gapped dock.
const removedGap = removeTile(gapped, tileKey(ten[2]));
t.equal(removedGap[2].kind, "spacer", "Remove leaves a gap in place");
t.equal(tileKey(removedGap[16]), tileKey(ten[9]), "the icons after a removed one keep their slots (and pages)");
t.equal(removeTile(gapped, tileKey(ten[9])).length, 9, "removing the icon on page 3 trims the trailing gaps (page 3 drops away)");
t.equal(pageCount(removeTile(gapped, tileKey(ten[9])), layout), 2, "so the dock is two pages again");
t.deepEqual(moveTile(gapped, tileKey(ten[9]), -1).map(tileKey).slice(14, 17), ["spacer:14", tileKey(ten[9])], "Move earlier swaps the page-3 icon with the gap before it (the gap left at the end is trimmed)");
t.deepEqual(moveTile(gapped, tileKey(ten[8]), 1).map(tileKey).slice(8, 10), ["spacer:8", tileKey(ten[8])], "Move later swaps an icon with the gap after it");

// Adding fills the first gap.
const added = addAppTile(gapped, { id: "c:/new.exe", target: "C:\\new.exe", name: "New" });
t.equal(tileKey(added[9]), "app:c:/new.exe", "a new app fills the first gap (page 2)");
t.equal(added.length, gapped.length, "no slot is appended while a gap exists");

// Density (4/6/8): the slot sequence is kept and the pages re-flow.
for (const perPage of [4, 6, 8]) {
  const grid = normalizeLayout({ perPage });
  const html = renderPages({ tiles: gapped }, grid);
  t.equal(pageCount(gapped, grid), Math.ceil(17 / perPage), `${perPage} per page: pages re-flow over the same 17 slots`);
  t.deepEqual([...html.matchAll(/data-tile-key="([^"]+)"/g)].map((m) => m[1]), ten.map(tileKey), `${perPage} per page: icon order is unchanged`);
  const page = Math.floor(16 / perPage);
  t.ok(pageOf(html, page).includes(`data-tile-key="${tileKey(ten[9])}"`), `${perPage} per page: the moved icon is on the page its slot falls in`);
}

// Gaps are invisible to running dots, close buttons and labels.
const liveGapped = gapped.map((tile) => (tile.kind === "app" ? { ...tile, running: true, close: { count: 1, state: "rest" } } : tile));
const liveHtml = renderPages({ tiles: liveGapped }, layout);
t.equal(count(liveHtml, /class="tile__close"/g), 10, "one close button per running icon, none for gaps");
t.equal(count(liveHtml, /class="tile__dot"/g), 10, "one running dot per running icon, none for gaps");
t.equal(count(liveHtml, /<button class="tile /g), 10, "keyboard focus visits the 10 icons only");

let active = 0, peak = 0, calls = 0;
const iconCache = createIconCache({ appIcon: async () => { active++; calls++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return Buffer.from("icon"); } });
await Promise.all([...tiles, tiles[0]].map(iconCache));
t.equal(calls, 17, "simultaneous duplicate icon requests share extraction");
t.ok(peak <= 3, "large libraries limit native extraction concurrency");
t.equal((await createIconCache({ appIcon: async () => { throw new Error("missing resource"); } })(tiles[0])), null, "missing resource is a graceful fallback");

for (const throws of [false, true]) {
  let time = 100, attempts = 0;
  const recovered = Buffer.from("recovered icon");
  const retryCache = createIconCache({ appIcon: async () => {
    if (++attempts > 1) return recovered;
    if (throws) throw new Error("helper temporarily unavailable");
    return null;
  } }, { now: () => time, retryAfterMs: 5000 });
  t.equal(await retryCache(tiles[0]), null, "temporary failure returns a fallback");
  time += 4999;
  t.equal(await retryCache(tiles[0]), null, "missing icons back off briefly");
  t.equal(attempts, 1, "repeated missing icon requests do not flood the helper");
  time++;
  const results = await Promise.all([retryCache(tiles[0]), retryCache(tiles[0])]);
  t.ok(results.every((result) => result === recovered), "real icon recovers after a temporary failure");
  t.equal(attempts, 2, "concurrent recovery requests share one extraction");
  time += 5000;
  t.equal(await retryCache(tiles[0]), recovered, "recovered icons stay cached");
  t.equal(attempts, 2, "successful icons are not extracted again");
}

const png = await readFile(new URL("../public/icon-192.png", import.meta.url));
const nativeCalls = [];
const provider = createWindowsProvider({ helperPath: "H.exe", exec: async (file, args) => {
  if (file === "H.exe") { nativeCalls.push(args); return { stdout: JSON.stringify({ png: args[1].includes("missing") ? null : png.toString("base64") }) }; }
  return { stdout: args.at(-1).includes("WScript.Shell") ? JSON.stringify([{ name: "App", target: "C:\\Apps\\real.exe", icon: "C:\\Icons\\app.dll,-4" }, { name: "Missing icon", target: "C:\\Apps\\missing.exe" }]) : "[]" };
} });
const dir = await mkdtemp(join(tmpdir(), "windock-icons-"));
const app = await createApp({ provider, configStore: createConfigStore({ path: join(dir, "config.json") }), trustLoopback: false, pin: "643200" });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`;
try {
  const path = "/api/apps/icon?id=" + encodeURIComponent("c:/apps/real.exe");
  const unauthorized = await fetch(base + path);
  t.equal(unauthorized.status, 401, "icons require pairing"); await unauthorized.text();
  const auth = await fetch(base + "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "643200" }) });
  const cookie = auth.headers.get("set-cookie").split(";")[0]; await auth.text();
  const response = await fetch(base + path, { headers: { cookie } });
  t.equal(response.status, 200, "paired client gets its installed app icon");
  t.equal(response.headers.get("content-type"), "image/png", "native icon has PNG content type");
  t.ok(Buffer.from(await response.arrayBuffer()).equals(png), "binary icon bytes survive the API round trip");
  t.ok(response.headers.get("cache-control").startsWith("private"), "icons are never cached publicly");
  t.deepEqual(nativeCalls[0], ["icon", "C:\\Apps\\real.exe", "C:\\Icons\\app.dll,-4"], "native arguments come only from installed inventory");
  const unknown = await fetch(base + "/api/apps/icon?id=" + encodeURIComponent("C:\\secret.txt"), { headers: { cookie } });
  t.equal(unknown.status, 404, "arbitrary file paths cannot reach the extractor"); await unknown.text();
  const second = await fetch(base + path, { headers: { cookie } }); await second.arrayBuffer();
  t.equal(nativeCalls.length, 1, "repeat requests use the server icon cache");
  const fallback = await fetch(base + "/api/apps/icon?id=" + encodeURIComponent("c:/apps/missing.exe"), { headers: { cookie } });
  t.equal(fallback.headers.get("content-type"), "image/svg+xml", "unavailable icons still have a usable placeholder");
  t.equal(fallback.headers.get("cache-control"), "private, no-store", "phones must never cache a failed icon lookup");
  await fallback.arrayBuffer();
} finally {
  app.server.closeAllConnections(); await app.hub.close(); await new Promise((r) => app.server.close(r)); await rm(dir, { recursive: true, force: true });
}
t.done("launcher verification passed");
