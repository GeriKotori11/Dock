/** G15: tiles can be added, removed and reordered from the dock UI. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import {
  tileKey,
  toWireTiles,
  hasTile,
  addAppTile,
  addControlTile,
  removeTile,
  moveTile,
  availableControls,
  catalogVerbs,
  CONTROL_CATALOG,
  placeTile,
  realTiles,
  trimSpacers,
  isSpacer,
  lastRealIndex,
  MAX_REAL_TILES as CLIENT_MAX_REAL,
  MAX_SLOTS,
} from "../public/tiles.js";
import { renderTiles, renderTile, renderControlPicker, renderControls } from "../public/dock.js";
import { powerCaps } from "../public/dock-controls.js";
import { CONTROL_VERBS, verbTakesValue } from "../src/platform/contract.js";
import { normalizeTile, normalizeTiles, MAX_TILES, MAX_REAL_TILES } from "../src/config.js";
import { createApp } from "../server.js";
import { createWindowsProvider } from "../src/platform/windows.js";
import { createConfigStore } from "../src/config.js";

const t = createChecker("editing");
const APP = { id: "c:/a.exe", target: "C:\\A.exe", name: "Alpha" };
const APP2 = { id: "c:/b.exe", target: "C:\\B.exe", name: "Beta" };

// ---- keys ----
t.equal(tileKey({ kind: "control", verb: "lock" }), "control:lock", "control tiles key on their verb");
t.equal(tileKey({ kind: "app", id: "c:/a.exe" }), "app:c:/a.exe", "app tiles key on their id");
t.equal(tileKey(null), "", "a null tile has no key");

// ---- add ----
let tiles = addAppTile([], APP);
t.equal(tiles.length, 1, "an app tile is added to an empty dock");
t.equal(tiles[0].label, "Alpha", "the app name becomes the tile label");
t.equal(tiles[0].kind, "app", "the added tile is an app tile");
t.deepEqual(addAppTile(tiles, APP), tiles, "adding the same app twice is a no-op");
t.deepEqual(addAppTile(tiles, { id: "", target: "" }), tiles, "an invalid app is not added");
t.deepEqual(addAppTile(tiles, null), tiles, "a null app is not added");

tiles = addControlTile(tiles, "mute-toggle", "Mute");
t.equal(tiles.length, 2, "a control tile is added alongside app tiles");
t.equal(tiles[1].kind, "control", "the added control tile has the control kind");
t.equal(tiles[1].verb, "mute-toggle", "the control tile carries its verb");
t.deepEqual(addControlTile(tiles, "mute-toggle", "Mute"), tiles, "adding the same control twice is a no-op");
t.deepEqual(addControlTile(tiles, "", "x"), tiles, "an empty verb is not added");

// Immutability: the helpers must never mutate the caller's array.
const original = [...tiles];
addAppTile(tiles, APP2);
removeTile(tiles, "app:c:/a.exe");
moveTile(tiles, "app:c:/a.exe", 1);
t.deepEqual(tiles, original, "editing helpers never mutate their input");

// ---- remove ----
const removed = removeTile(tiles, "app:c:/a.exe");
t.deepEqual(removed.map((x) => x.kind), ["spacer", "control"], "removing a tile leaves an empty slot so the others keep their places");
t.ok(!hasTile(removed, "app:c:/a.exe"), "the removed tile is gone");
t.ok(hasTile(removed, "control:mute-toggle"), "the other tile survives removal");
t.deepEqual(removeTile(tiles, "app:nope"), toWireTiles(tiles), "removing an absent key is a no-op");
t.deepEqual(removeTile([], "x"), [], "removing from an empty dock is safe");

// ---- reorder ----
let three = addAppTile(addControlTile(addAppTile([], APP), "lock", "Lock"), APP2);
t.deepEqual(three.map(tileKey), ["app:c:/a.exe", "control:lock", "app:c:/b.exe"], "initial order is insertion order");

t.deepEqual(
  moveTile(three, "app:c:/b.exe", -1).map(tileKey),
  ["app:c:/a.exe", "app:c:/b.exe", "control:lock"],
  "a tile moves one place earlier",
);
t.deepEqual(
  moveTile(three, "app:c:/a.exe", 1).map(tileKey),
  ["control:lock", "app:c:/a.exe", "app:c:/b.exe"],
  "a tile moves one place later",
);
t.deepEqual(moveTile(three, "app:c:/a.exe", -1).map(tileKey), three.map(tileKey), "the first tile cannot move earlier");
t.deepEqual(moveTile(three, "app:c:/b.exe", 1).map(tileKey), three.map(tileKey), "the last tile cannot move later");
t.deepEqual(moveTile(three, "nope", 1).map(tileKey), three.map(tileKey), "moving an absent tile is a no-op");
t.deepEqual(moveTile(three, "app:c:/a.exe", 0).map(tileKey), three.map(tileKey), "a zero move is a no-op");
t.deepEqual(
  moveTile(three, "app:c:/a.exe", 99).map(tileKey),
  ["control:lock", "app:c:/b.exe", "app:c:/a.exe"],
  "an oversized move clamps to the end",
);

// ---- wire format ----
const wire = toWireTiles([{ kind: "app", id: "x", target: "t", label: "L", running: true, bogus: 1 }]);
t.equal(wire[0].running, undefined, "the runtime running flag is stripped before saving");
t.equal(wire[0].bogus, undefined, "unknown fields are stripped before saving");
t.equal(wire[0].id, "x", "the id survives the wire conversion");
t.deepEqual(toWireTiles([{ kind: "nope" }, null, 7]), [], "junk entries are dropped from the wire format");

// ---- catalogue ----
const verbs = catalogVerbs();
t.deepEqual(
  CONTROL_VERBS.filter((v) => !verbs.includes(v)),
  [],
  "every host control verb is offered by the picker catalogue",
);
t.deepEqual(
  verbs.filter((v) => !CONTROL_VERBS.includes(v)),
  [],
  "the catalogue offers no verb the host does not implement",
);
t.equal(new Set(verbs).size, verbs.length, "no verb appears twice in the catalogue");
t.ok(CONTROL_CATALOG.length >= 4, "the catalogue is grouped for a phone-sized list");

const groups = availableControls(CONTROL_VERBS, [{ kind: "control", verb: "lock", label: "Lock" }]);
const flat = groups.flatMap((g) => g.items);
t.ok(flat.length >= CONTROL_VERBS.length, `every verb is represented (${flat.length} entries)`);
t.equal(flat.find((i) => i.verb === "lock").pinned, true, "an already-pinned control is marked pinned");
t.equal(flat.find((i) => i.verb === "sleep").pinned, false, "an unpinned control is not marked pinned");

// Valued verbs MUST ship a value in the catalogue. A valueless entry would
// render a tile whose tap sends an incomplete request the host rejects.
for (const verb of CONTROL_VERBS.filter(verbTakesValue)) {
  const entries = flat.filter((i) => i.verb === verb);
  t.ok(entries.length > 0, `${verb} is offered in the picker`);
  t.ok(
    entries.every((e) => Number.isInteger(e.value)),
    `${verb} picker entries all carry an integer value`,
  );
}
// Valueless verbs must NOT carry one.
for (const verb of CONTROL_VERBS.filter((v) => !verbTakesValue(v))) {
  t.ok(
    flat.filter((i) => i.verb === verb).every((e) => e.value === undefined),
    `${verb} picker entries carry no value`,
  );
}

// Two presets of the same verb are distinct tiles, not a collision.
const twoVolumes = addControlTile(addControlTile([], "volume-set", "Volume 25%", 25), "volume-set", "Volume 75%", 75);
t.equal(twoVolumes.length, 2, "two presets of one verb coexist as separate tiles");
t.deepEqual(
  twoVolumes.map(tileKey),
  ["control:volume-set:25", "control:volume-set:75"],
  "valued tiles key on verb and value",
);
t.deepEqual(
  addControlTile(twoVolumes, "volume-set", "Volume 25%", 25),
  twoVolumes,
  "re-adding an identical preset is a no-op",
);
t.equal(addControlTile([], "volume-set", "x", 1.5).length, 0, "a non-integer value is refused");

// Pinned marking must be value-aware.
const pinnedVolume = availableControls(CONTROL_VERBS, twoVolumes).flatMap((g) => g.items);
t.equal(pinnedVolume.find((i) => i.verb === "volume-set" && i.value === 25).pinned, true,
  "the pinned volume preset is marked pinned");
t.equal(pinnedVolume.find((i) => i.verb === "volume-set" && i.value === 50).pinned, false,
  "an unpinned preset of the same verb is not marked pinned");

// ---- the original defect: a valued verb with no value must be rejected ----
t.equal(normalizeTile({ kind: "control", verb: "brightness-set", label: "B" }), null,
  "a valued verb with no value is rejected by the host (regression: it used to be accepted)");
t.equal(normalizeTile({ kind: "control", verb: "volume-set", label: "V" }), null,
  "volume-set with no value is rejected");
t.equal(normalizeTile({ kind: "control", verb: "volume-set", value: 500 }), null,
  "an out-of-range value is rejected");
t.equal(normalizeTile({ kind: "control", verb: "volume-set", value: 12.5 }), null,
  "a fractional value is rejected");
t.equal(normalizeTile({ kind: "control", verb: "lock", value: 50 }), null,
  "a valueless verb carrying a value is rejected");
const okValued = normalizeTile({ kind: "control", verb: "volume-set", value: 40, label: "V40" });
t.ok(okValued && okValued.value === 40, "positive control: a correctly valued tile is accepted");
const okPlain = normalizeTile({ kind: "control", verb: "lock", label: "Lock" });
t.ok(okPlain && okPlain.value === undefined, "positive control: a valueless verb is accepted without a value");

// ---- rendering ----
const view = { tiles: three };
const normal = renderTiles(view);
t.ok(!normal.includes('data-action="remove"'), "the normal dock shows no remove buttons");
t.ok(normal.includes('data-action="launch"'), "the normal dock shows launch actions");

const edit = renderTiles(view, { editing: true });
t.equal((edit.match(/data-action="remove"/g) || []).length, 3, "every tile gets a remove button when editing");
t.equal((edit.match(/data-action="move-up"/g) || []).length, 3, "every tile gets a move-up button when editing");
t.ok(!edit.includes('data-action="launch"'), "editing mode removes launch actions so a tap cannot fire one");
t.ok(!edit.includes('data-action="control"'), "editing mode removes control actions");
t.equal((edit.match(/disabled/g) || []).length, 2, "the first and last tiles have one disabled move each");
t.ok(edit.includes("is-editing"), "editing tiles carry the editing class");

const single = renderTile({ kind: "app", id: "x", label: "X" }, { editing: true, first: true, last: true });
t.equal((single.match(/disabled/g) || []).length, 2, "a lone tile cannot move in either direction");

const pickerHtml = renderControlPicker(groups);
t.ok(pickerHtml.includes('data-verb="lock"'), "the control picker renders verbs");
t.ok(pickerHtml.includes("picker__group"), "the control picker renders group headings");
t.ok(/data-verb="lock"[^>]*disabled/.test(pickerHtml), "an already-pinned control is disabled in the picker");
t.equal(renderControlPicker([]), '<li class="picker__empty">No controls available.</li>', "an empty catalogue renders an empty state");
t.equal(renderControlPicker(null), '<li class="picker__empty">No controls available.</li>', "a null catalogue renders an empty state");

// XSS: labels reach the picker and the dock.
const hostile = renderControlPicker([{ group: '<img src=x onerror="a()">', items: [] }]);
t.ok(!hostile.includes("<img"), "a hostile group name cannot inject an element");

// ---- Controls sheet after DOCK-CONTROLS (section 4, 17) ----
const legacyControls = renderControls(CONTROL_VERBS, true);
t.ok(!legacyControls.includes("Playback") && !legacyControls.includes('data-key="media-next"'), "the Controls sheet no longer has a Playback card");
t.ok(legacyControls.includes("<h3>Sound</h3>") && legacyControls.includes("<h3>Display</h3>") && legacyControls.includes("<h3>Your PC</h3>"), "Sound, Display and Your PC stay");
t.ok(legacyControls.includes("Shut down and restart ask first."), "the power card's hint says only shut down and restart ask");
t.ok(!renderControls(CONTROL_VERBS, false).includes('data-key="sleep"') && renderControls(CONTROL_VERBS, false).includes('data-key="lock"'), "without a power map, allowDestructive false still hides sleep (old rule)");
const macPower = powerCaps({ features: { power: { lock: "ready", sleep: "ready", restart: "needs-permission", shutdown: "needs-permission" } } });
const macControls = renderControls(["volume-up", "volume-down", "mute-toggle"], true, { power: macPower, kind: "Mac" });
t.ok(macControls.includes("<h3>Your Mac</h3>") && (macControls.match(/data-key="(lock|sleep|restart|shutdown)"/g) || []).length === 4, "a Mac host gets Your Mac with every power action it offers");
t.equal(renderControls([], true, { power: powerCaps({ features: { power: {} } }) }), "", "nothing offered renders no cards, so Controls hides");
const noDestructive = renderControls(CONTROL_VERBS, false, { power: powerCaps({ features: { power: { lock: "ready", sleep: "ready", restart: "ready", shutdown: "ready" } }, allowDestructive: false }) });
t.ok(noDestructive.includes('data-key="lock"') && !/data-key="(sleep|restart|shutdown)"/.test(noDestructive), "with power actions disabled only Lock remains (5.6)");
// The picker's control list follows the same power map (app.js pickerVerbs).
const offered = CONTROL_VERBS.filter((verb) => !["lock", "sleep", "restart", "shutdown"].includes(verb) || powerCaps({ features: { power: { lock: "ready" } } })[verb]);
const pickerFlat = availableControls(offered, []).flatMap((g) => g.items).map((i) => i.verb);
t.ok(pickerFlat.includes("lock") && !pickerFlat.includes("sleep") && !pickerFlat.includes("shutdown"), "power the host doesn't offer is not offered in the picker");

// ---- empty slots (spacers): host normalization ----
const SP = { kind: "spacer" };
const appTile = (i) => ({ kind: "app", id: `c:/s${i}.exe`, target: `C:\\S${i}.exe`, label: `S${i}` });
t.deepEqual(normalizeTile({ kind: "spacer", label: "x", id: "y", running: true }), SP, "a spacer normalizes to its kind alone (no label or id)");
t.deepEqual(normalizeTiles([SP, appTile(1), SP, SP, appTile(2), SP, SP]).map((x) => x.kind), ["spacer", "app", "spacer", "spacer", "app"],
  "gaps (leading and middle) keep their places; trailing ones are trimmed");
t.deepEqual(normalizeTiles([SP, SP, SP]), [], "a list of only spacers normalizes to an empty dock");
t.equal(normalizeTiles([appTile(1), SP, appTile(1), SP, appTile(2)]).filter((x) => x.kind === "spacer").length, 2, "spacers are exempt from de-duplication while duplicate tiles are still dropped");
t.equal(MAX_TILES, 128, "the dock holds up to 128 slots");
t.equal(MAX_REAL_TILES, 64, "at most 64 of them are real tiles");
t.equal(CLIENT_MAX_REAL, MAX_REAL_TILES, "the phone and the host agree on the real-tile limit");
t.equal(MAX_SLOTS, MAX_TILES, "the phone and the host agree on the slot limit");
const seventy = Array.from({ length: 70 }, (_, i) => appTile(i));
t.equal(normalizeTiles(seventy).length, 64, "more than 64 real tiles are capped at 64");
const spread = Array.from({ length: 64 }, (_, i) => [appTile(i), SP]).flat();
t.equal(normalizeTiles(spread).length, 127, "64 icons with a gap after each fit in 128 slots");
const overfull = [...Array(100).fill(SP), ...Array.from({ length: 60 }, (_, i) => appTile(i))];
const capped = normalizeTiles(overfull);
t.ok(capped.length <= 128, `an over-long list is held to 128 slots (got ${capped.length})`);
t.equal(capped.filter((x) => x.kind === "app").length, 60, "over the slot limit gaps are dropped, never real tiles");
t.equal(normalizeTiles(Array(500).fill(SP).concat([appTile(1)])).length, 1 + (128 - 1), "a long run of gaps cannot push a tile past the slot limit");

// ---- empty slots: dock operations ----
const A = appTile("A"), B = appTile("B"), C = appTile("C");
const kA = tileKey(A), kB = tileKey(B), kC = tileKey(C);
const keysOf = (list) => list.map(tileKey);
t.deepEqual(keysOf([A, SP, SP, B]), [kA, "spacer:1", "spacer:2", kB], "spacer keys are per position, so a rendered page's keys stay unique");
t.equal(tileKey(SP), "spacer:", "a bare spacer key never matches a real tile or a positioned spacer");
t.ok(!hasTile([A, SP], "spacer:"), "a spacer is never found as a pinned tile");
t.deepEqual(toWireTiles([A, { kind: "spacer", label: "x" }, B, SP, SP]), [{ ...A, args: "", icon: "" }, SP, { ...B, args: "", icon: "" }],
  "the wire format keeps gaps as { kind: spacer } and trims trailing ones");
t.deepEqual(trimSpacers([SP, A, SP]), [SP, A], "trimSpacers drops only trailing gaps");
t.equal(lastRealIndex([A, SP, B, SP]), 2, "the last real tile is found past gaps");
t.equal(lastRealIndex([SP, SP]), -1, "a dock of only gaps has no real tile");
t.equal(realTiles([SP, A, SP, B]).length, 2, "realTiles skips gaps");
t.ok(isSpacer(SP) && !isSpacer(A) && !isSpacer(null), "isSpacer tells gaps from tiles");

// Remove leaves a gap; the trailing one is trimmed.
t.deepEqual(keysOf(removeTile([A, B, C], kB)), [kA, "spacer:1", kC], "removing a middle tile leaves a gap so the icons after it stay put");
t.deepEqual(keysOf(removeTile([A, SP, B], kB)), [kA], "removing the last tile trims the gaps before it too");
t.deepEqual(removeTile([A], kA), [], "removing the only tile empties the dock");

// Move earlier / later swaps with the neighbouring slot, spacer or tile.
t.deepEqual(keysOf(moveTile([A, SP, B], kB, -1)), [kA, kB], "moving earlier into a gap swaps with it (the trailing gap is trimmed)");
t.deepEqual(keysOf(moveTile([A, SP, B, C], kB, -1)), [kA, kB, "spacer:2", kC], "moving earlier across a gap swaps with the gap");
t.deepEqual(keysOf(moveTile([A, SP, B], kA, 1)), ["spacer:0", kA, kB], "moving later into a gap swaps with it");
t.deepEqual(keysOf(moveTile([A, B, SP, C], kA, 1)), [kB, kA, "spacer:2", kC], "moving later onto a tile swaps with that tile");
t.deepEqual(keysOf(moveTile([SP, A], kA, -1)), [kA], "moving the only tile earlier into a leading gap brings it to slot 0");

// Drop on an empty slot: exact placement, padded past the end.
t.deepEqual(keysOf(placeTile([A, B, C], kA, 5)), ["spacer:0", kB, kC, "spacer:3", "spacer:4", kA], "a drop past the end pads with gaps and leaves a gap behind");
t.deepEqual(keysOf(placeTile([A, SP, B], kB, 1)), [kA, kB], "a drop into a gap fills it (the left-behind trailing gap is trimmed)");
t.deepEqual(keysOf(placeTile([A, B], kA, 1)), [kA, kB], "an occupied slot is not a place target");
t.deepEqual(keysOf(placeTile([A, B], "app:missing", 4)), [kA, kB], "a stale key places nothing");
t.deepEqual(keysOf(placeTile([A, B], kA, MAX_SLOTS)), [kA, kB], "a drop beyond the slot limit is refused");
t.deepEqual(keysOf(placeTile([A, B], kB, MAX_SLOTS - 1)).length, MAX_SLOTS, "the very last slot is reachable");

// Adding fills the first gap, else appends.
t.deepEqual(keysOf(addAppTile([A, SP, SP, B], APP)), [kA, tileKey(addAppTile([], APP)[0]), "spacer:2", kB], "a new app fills the first gap");
t.deepEqual(keysOf(addControlTile([SP, A], "lock", "Lock")), ["control:lock", kA], "a new control fills a leading gap");
t.deepEqual(keysOf(addAppTile([A, B], APP)).at(-1), "app:c:/a.exe", "with no gap a new tile is appended");
const full = Array.from({ length: 64 }, (_, i) => [appTile(i), SP]).flat();
t.equal(realTiles(addAppTile(full, APP2)).length, 64, "a dock already holding 64 real tiles takes no more, gaps or not");

// ---- the host accepts an edited list end to end ----
const provider = createWindowsProvider({
  helperPath: "H.exe",
  exec: async (file, args) => {
    if (file === "H.exe") return { stdout: "" };
    const script = args[args.length - 1];
    if (script.includes("MainWindowHandle")) return { stdout: "[]" };
    if (script.includes("WScript.Shell")) return { stdout: "[]" };
    return { stdout: "{}" };
  },
});
const dir = await mkdtemp(join(tmpdir(), "windock-edit-"));
const configStore = createConfigStore({ path: join(dir, "config.json") });
const app = await createApp({ provider, configStore, pin: "111111", trustLoopback: true });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`;

const put = await fetch(`${base}/api/tiles`, {
  method: "PUT",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ tiles: toWireTiles(three) }),
});
t.equal(put.status, 200, "the host accepts an edited tile list");
const saved = await put.json();
t.deepEqual(saved.tiles.map(tileKey), three.map(tileKey), "the host persists the exact order sent");

const reordered = moveTile(three, "app:c:/b.exe", -1);
const put2 = await fetch(`${base}/api/tiles`, {
  method: "PUT",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ tiles: toWireTiles(reordered) }),
});
t.equal(put2.status, 200, "the host accepts a reordered list");
t.deepEqual((await put2.json()).tiles.map(tileKey), reordered.map(tileKey), "the new order round-trips");

const gappedList = toWireTiles(placeTile(three, "app:c:/a.exe", 9));
const put3 = await fetch(`${base}/api/tiles`, {
  method: "PUT",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ tiles: gappedList }),
});
t.deepEqual((await put3.json()).tiles.map(tileKey), gappedList.map(tileKey), "a layout with gaps (an icon on a later page) round-trips through the host");

const emptied = await fetch(`${base}/api/tiles`, {
  method: "PUT",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ tiles: [] }),
});
t.equal(emptied.status, 200, "the host accepts removing every tile");
t.equal((await emptied.json()).tiles.length, 0, "an emptied dock persists as empty");

app.server.closeAllConnections?.();
await app.hub.close();
await new Promise((r) => app.server.close(r));
await rm(dir, { recursive: true, force: true });

t.done("editing verification passed");
