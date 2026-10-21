import { renderControlPicker, renderAppIcon, renderControls, renderMiniPlayer, renderMediaSheet, renderVolumeRow, escapeHtml } from "./dock.js";
import { icon, controlIcon } from "./icons.js";
import { addAppTile, addControlTile, addSpotifyTile, hasTile, removeTile, moveTile, toWireTiles, availableControls, tileKey, realTiles } from "./tiles.js";
import { normalizeLayout, renderPages, pageCount, moveToTile, dropOnSlot } from "./launcher.js";
import { createInputPad } from "./input-pad.js";
import { createMediaPoller, normalizeMedia, fromNowPlaying, mediaPosition, formatTime, spokenTime } from "./now-playing.js";
import {
  computerKind, powerCaps, offersPower, shutdownEntry, volumeMode, mediaCaps, showMediaButton, showFullscreenButton,
  closeTarget, closeLabels, createArming, createThrottle, expectDisconnect, readExpected, pillVariant, pillContent,
  closeOutcome, pendingPermission, miniPlayerMode, shutdownDialog, powerToast, powerLabels, RESTART_GRACE_MS,
  miniVolumeMode, miniMuteMode, miniVolumeShown, miniVolumeChip, stepVolume, createVolumeStepper, createHoldRepeat, seekAria, seekFromPointer, seekKey, CHIP_HIDE_MS,
} from "./dock-controls.js";
import { readNative, displayName, wantsSwitcher, shouldHandOff, postToNative, renderSwitchRow } from "./native-bridge.js";
import {
  SP_COPY, PAGE_SIZE, LONG_PRESS_MS, WAIT_STOP_MS, MAX_TILES, spotifyAccount, spotifyInstalled, isSpotifySource, spotifyMode, spotifyTab, nextTab,
  normalizePage, mergePage, normalizeDevices, normalizeSpotifyStatus, activeDevice, playBody, spotifyTile, isTileUri, spotifyError, createSearch, LIKED_CONTEXT,
  spotifyBrand, spotifyCover, renderSpTabs, renderSpEntry, renderSpWaiting, renderSpLibrary, renderSpSearchPanel, renderSpResults, renderSpDevices, renderSpFooter,
  renderSpUpNext, renderLikeButton, renderSpMenuActions, renderUpNextButton, renderSpQueuePanel, upNextButton, mediaBackStep, createQueueLoader, UP_NEXT_WIDE_MIN,
} from "./spotify.js";

const $ = (id) => document.getElementById(id);
// Close a <dialog> outright, past the Media sheet's Back step (its close() is overridden below).
function closeDialog(dialog, value) { HTMLDialogElement.prototype.close.call(dialog, value); }
const pluralize = (count, word, plural = word + "s") => count + " " + (count === 1 ? word : plural);
let state = { tiles: [], running: [], verbs: [] };
let editing = false, paired = false, online = false, saving = false;
let socket = null, reconnectTimer = null, installedApps = [], appsLoaded = false;
let currentPage = 0, toastTimer, selectedKey = "", suppressClickUntil = 0;
let pageHintTimer, offlineTimer;
let captureState = { available: false, phase: "idle" }, captureBusy = false, capturePoll = false, captureReceivedAt = Date.now();
// Dock controls (DOCK-CONTROLS.md): close arming, media, volume and power.
let lastDockHtml = "", previousRunning = new Set(), paintedOnce = false;
const closeStates = new Map();
let suppressCloseUntil = 0, offlineVisible = false, disconnectedAt = null, pillTimer = null;
let media = null, mediaReceivedAt = 0, mediaLegacyFallback = false, sourcesOpen = false, seeking = false, miniLeaveTimer = null;
let volume = { level: null, muted: false, dragging: false, loading: false };
let permissionUi = { player: null, asking: false, stopped: false, denied: false, later: null, timer: null };
const miniDismissed = new Set();
// Mini player volume buttons and seek line (5.2 additions).
let miniSeek = null, miniVolumeFetched = false, miniChipTimer = null, miniLegacyHold = null;
// Mini player volume − / +: 5 per step from the last known level, held = repeat,
// requests throttled like the sheet's slider (8.4). Every reply is applied and errors reported.
const miniStepper = createVolumeStepper({
  getLevel: () => volume.level,
  onLevel: (level) => { volume.level = level; paintVolume(false); showMiniChip(); },
  send: (level) => {
    const change = unmuteWithLevel ? { level, muted: false } : { level };
    unmuteWithLevel = false;
    sendVolume(change, true);
  },
});
// Spotify account (Phase B, DOCK-CONTROLS 12): the tab, the login flow on the
// computer and what the host's Web API proxy last told us. Rebuilt per connection.
const sp = {
  tab: "now", account: null, flow: null, disconnected: false, notConnected: false, status: null, liked: null, likeBusy: false,
  library: null, likedTotal: null, likedFirst: null, devices: null, devicesLoading: false, devicesError: null,
  queue: [], queueSupported: true, queueLoaded: false, queueError: null, queueOpen: false, lastContext: null, menuItem: null,
  search: { text: "", query: "", resultsQuery: "", results: null, loading: false, error: null },
};
// Volume up while muted unmutes and raises, as the computer's own volume keys do.
let unmuteWithLevel = false;
const POWER_VERBS = new Set(["lock", "sleep", "restart", "shutdown"]);
const EXPECTED_KEY = "windock-expected";
// Native shell hand-shakes: ready is posted once, unauthorized once per lost session.
let readySent = false, handedOff = false;
// Hosts before per-host features sent no `features`; treat that as everything on.
const feature = (name) => state.features?.[name] !== false;
// The newer capability keys (close, media, volume, power) read missing as off (spec 6.6).
const caps = () => ({ features: state.features, verbs: state.verbs, allowDestructive: state.allowDestructive });
const computerName = (fallback = "your computer") => displayName(readNative(), state.hostName, fallback);
const sentenceName = () => computerName("Your computer");
// App tiles the host's catalog no longer has. Kept apart from state.tiles so
// local edits (whose saved tiles carry no availability) keep the dimming.
let unavailableIds = new Set();
function absorbState(fresh) {
  unavailableIds = new Set((fresh.tiles || []).filter((tile) => tile.kind === "app" && tile.available === false).map((tile) => tile.id));
}
// One poller for /api/media (new hosts) or /api/nowplaying (older hosts):
// single-flight, and only while paired, online, visible and wanted.
const mediaPoller = createMediaPoller({
  load: loadMedia,
  isActive: () => paired && online && !document.hidden && mediaWanted(),
  onChange: applyMedia,
});
// The system volume uses the same ordered poller: a read that started before a
// volume or mute change was answered can't flip the optimistic state back.
const volumePoller = createMediaPoller({
  load: loadVolume,
  isActive: () => $("media").open && paired && online && !document.hidden && !volume.dragging,
  onChange: applyVolume,
});
let layout;
try { layout = normalizeLayout(JSON.parse(localStorage.getItem("windock-layout"))); } catch { layout = normalizeLayout(); }
document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
if (typeof window.WinDockAndroid?.showPhoneSettings === "function") {
  $("phone-options-row").hidden = false;
  $("phone-options").addEventListener("click", () => window.WinDockAndroid.showPhoneSettings());
}
document.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement && event.target.closest(".app-icon")) event.target.parentElement.classList.add("icon-failed");
  if (event.target instanceof HTMLImageElement && event.target.classList.contains("art-img")) event.target.classList.add("icon-failed");
}, true);
// New artwork fades in over its fallback once it has loaded (spec 10).
document.addEventListener("load", (event) => {
  if (event.target instanceof HTMLImageElement && event.target.classList.contains("art-img")) event.target.classList.add("is-loaded");
}, true);

// `tone`: false/"success", true/"error", or "neutral" (an outcome that isn't a failure).
function notify(message, tone = false) {
  clearTimeout(toastTimer);
  const kind = tone === true || tone === "error" ? "error" : tone === "neutral" ? "neutral" : "success";
  const el = $("toast");
  el.textContent = message;
  el.dataset.error = String(kind === "error");
  el.dataset.tone = kind;
  // Native dialogs occupy the top layer; feedback belongs inside the active one.
  (Array.from(document.querySelectorAll("dialog[open]")).at(-1) || document.body).append(el);
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === "success" ? 2700 : 5500);
}
// Results of the user's own actions only; never track changes (spec 11).
function announce(message) {
  const el = $("live");
  el.textContent = "";
  requestAnimationFrame(() => { el.textContent = message; });
}
function offlineMessage() { return sentenceName() + " is disconnected. Waiting for it to reconnect."; }
function report(error) {
  if (error.message === "unauthorized") return;
  notify(error.message === "Failed to fetch" ? "Connection lost. Check that WinDock is running on your computer." : error.message, true);
}
function captureActive() { return ["starting", "recording", "stopping"].includes(captureState.phase); }
function captureTime() {
  const seconds = Math.floor(((captureState.elapsedMs || 0) + (captureState.phase === "recording" ? Date.now() - captureReceivedAt : 0)) / 1000);
  return Math.floor(seconds / 60).toString().padStart(2, "0") + ":" + (seconds % 60).toString().padStart(2, "0");
}
function paintCapture() {
  const active = captureActive();
  const waiting = ["starting", "stopping"].includes(captureState.phase);
  $("recording-stop").hidden = !paired || !active;
  $("recording-stop").disabled = !online || captureBusy || waiting;
  $("recording-time").textContent = !online ? "Reconnecting…" : waiting ? (captureState.phase === "starting" ? "Starting…" : "Saving…") : captureTime();
  $("capture-screenshot").disabled = !online || !captureState.available || captureBusy || waiting;
  $("capture-record").disabled = !online || !captureState.available || captureBusy || waiting;
  $("capture-record").classList.toggle("is-recording", active);
  $("capture-record-icon").innerHTML = icon(active ? "stop" : "record");
  $("capture-record-label").textContent = active ? (waiting ? (captureState.phase === "starting" ? "Starting…" : "Saving recording…") : "Stop recording") : "Start recording";
  $("capture-record-detail").textContent = active ? captureTime() + " · Video only" : "MP4 · Video only";
  $("capture-status").textContent = !online ? "PC disconnected. Any recording continues on the PC. Reconnect or stop from its tray menu." : captureState.error || (!captureState.available ? "Screen capture is available with the Windows host." : active ? "Recording your main monitor. Stop to save the video." : "Screenshots → Pictures / WinDock. Recordings → Videos / WinDock.");
  const last = captureState.lastCapture;
  $("capture-file").hidden = !last;
  $("capture-file").textContent = last ? "Last saved: " + last.path : "";
}
async function refreshCapture() {
  if (captureBusy || capturePoll) return;
  capturePoll = true;
  try {
    const fresh = await api("/api/capture");
    if (!captureBusy) { captureState = fresh; captureReceivedAt = Date.now(); paintCapture(); }
  } finally { capturePoll = false; }
}
async function captureAction(action) {
  if (captureBusy || !online) return;
  captureBusy = true; paintCapture();
  try {
    captureState = await api("/api/capture/" + action, { method: "POST", body: "{}" });
    captureReceivedAt = Date.now();
    if (action === "start") { $("capture").close(); notify("Recording started · Tap Stop to save"); }
    else notify(action === "screenshot" ? "Screenshot saved in Pictures / WinDock" : "Recording saved in Videos / WinDock");
  } catch (error) { report(error); }
  finally { captureBusy = false; paintCapture(); }
}
function openCapture() {
  $("drawer").close(); paintCapture();
  if (!$("capture").open) $("capture").showModal();
  refreshCapture().catch(report);
}
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "content-type": "application/json" } : {},
    ...options,
  });
  if (res.status === 401 && path !== "/api/auth") { showPair("Enter the current PIN to reconnect.", true); throw new Error("unauthorized"); }
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).error;
    const fail = (message) => Object.assign(new Error(message), { status: res.status, detail });
    const messages = { "wrong pin": "That PIN doesn’t match. Try the PIN shown on your computer.", "invalid pin": "Enter all six digits.", "pairing closed": "Pairing is closed. On your computer, show the PIN again (Windows: tray → Show connection info · Mac: npm run info), then enter the new PIN within 10 minutes.", locked: "Too many attempts. Wait a moment and try again.", "internal error": "Your computer couldn't complete that action. Try again.", "unknown app": "That app isn't installed on this computer anymore.", "launch failed": "The computer couldn't open that app. It may have been moved or removed.", "controls unavailable": "Controls aren't available on this computer." };
    throw fail(messages[detail] || detail || "The request couldn’t be completed.");
  }
  return res.json();
}
function showPair(message = "", unauthorized = false) {
  paired = false;
  paintCapture();
  syncLayout();
  clearTimeout(reconnectTimer);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  for (const dialog of document.querySelectorAll("dialog[open]")) closeDialog(dialog);
  // Inside a native shell, native asks for the new PIN (spec 4.13): keep the
  // dock dimmed behind it rather than showing the web PIN page.
  if (shouldHandOff(readNative(), unauthorized)) {
    syncOffline();
    $("dock").classList.add("is-offline");
    if (!handedOff) handedOff = postToNative(window, { type: "unauthorized" });
    return;
  }
  $("pair").hidden = false;
  $("app").hidden = true;
  $("pair-error").textContent = message;
  syncOffline();
}
function showApp() { paired = true; handedOff = false; $("pair").hidden = true; $("app").hidden = false; syncLayout(); paintCapture(); syncOffline(); }
function setConn(on) {
  const was = online;
  online = on;
  if (on) { disconnectedAt = null; clearExpected(); }
  else {
    if (was) disconnectedAt = Date.now();
    arming.disarm("offline");
  }
  if (!on) inputPad.disconnect();
  $("conn").dataset.state = on ? "on" : "off";
  $("conn").textContent = on ? "Connected" : paired ? "Reconnecting" : "Connecting";
  $("drawer-conn").dataset.state = $("conn").dataset.state;
  $("drawer-conn").textContent = $("conn").textContent;
  paintCapture();
  syncPowerButtons();
  renderMedia();
  syncOffline();
}
// A brief socket blip stays silent; after 1.5 s offline the dock says so and dims.
// Reconnecting clears both at once.
function setOffline(visible) {
  clearTimeout(offlineTimer); offlineTimer = null;
  const changed = offlineVisible !== visible;
  offlineVisible = visible;
  syncPill();
  // Close buttons, running dots and the mini player hide while offline (6.1, 6.2).
  if (changed && paired) { paint(); renderMedia(); }
}
function syncOffline() {
  if (online || !paired) return setOffline(false);
  if (!offlineTimer && !offlineVisible) offlineTimer = setTimeout(() => setOffline(!online && paired), 1500);
}
// One pill for reconnecting, restarting, asleep, off and locked (5.7). After our
// own sleep / shut down / restart the dock remembers why it expects to lose the
// computer, so the pill can say so instead of pulsing.
function loadExpected() { try { return readExpected(sessionStorage.getItem(EXPECTED_KEY)); } catch { return null; } }
function storeExpected(memory) { try { sessionStorage.setItem(EXPECTED_KEY, JSON.stringify(memory)); } catch { /* Optional. */ } }
function clearExpected() { try { sessionStorage.removeItem(EXPECTED_KEY); } catch { /* Optional. */ } }
function syncPill() {
  const expected = loadExpected();
  const name = computerName();
  const variant = pillVariant({ paired, online, offlineVisible, locked: state.session?.locked === true, expected, computer: name, disconnectedAt, now: Date.now() });
  const content = pillContent(variant, variant === "reconnecting" ? name : sentenceName());
  const pill = $("reconnect");
  pill.dataset.visible = String(Boolean(content));
  if (content) {
    pill.dataset.variant = variant;
    pill.dataset.pulse = String(content.pulse);
    if ($("reconnect-text").textContent !== content.text) $("reconnect-text").textContent = content.text;
    $("reconnect-icon").innerHTML = content.icon ? icon(content.icon) : "";
  } else $("reconnect-text").textContent = "";
  $("dock").classList.toggle("is-offline", Boolean(content?.dim));
  clearTimeout(pillTimer); pillTimer = null;
  // "Restarting…" falls back to "Reconnecting…" after 5 minutes.
  if (variant === "restarting" && expected) pillTimer = setTimeout(syncPill, Math.max(1000, expected.at + RESTART_GRACE_MS - Date.now() + 50));
}
function syncLayout() {
  const root = document.documentElement.style;
  root.setProperty("--columns", layout.columns);
  root.setProperty("--rows", layout.rows);
  root.setProperty("--icon-size", (layout.immersive ? layout.iconSize : 72) + "px");
  root.setProperty("--icon-scale", { 4: .44, 6: .38, 8: .32 }[layout.perPage]);
  document.documentElement.dataset.background = layout.background;
  document.documentElement.dataset.theme = layout.theme;
  document.body.classList.toggle("is-immersive", layout.immersive);
  document.body.classList.toggle("show-labels", layout.showLabels);
  $("drawer-open").hidden = !layout.immersive || !paired;
  $("edit-done").hidden = !layout.immersive || !editing || !paired;
  $("immersive").checked = layout.immersive;
  $("show-labels").checked = layout.showLabels;
  $("show-labels").disabled = !layout.immersive;
  $("close-buttons").checked = layout.closeButtons;
  $("mini-setting").checked = layout.miniPlayer;
  $("glass-theme").value = layout.theme;
  $("layout-summary").textContent = layout.perPage + " icons · " + layout.columns + " × 2";
  document.querySelectorAll("[data-per-page]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.perPage) === layout.perPage)));
  document.querySelectorAll("[data-background]").forEach((button) => { if (button.tagName === "BUTTON") button.setAttribute("aria-pressed", String(button.dataset.background === layout.background)); });
  renderMedia();
}
function saveLayout(changes) {
  layout = normalizeLayout({ ...layout, ...changes });
  try { localStorage.setItem("windock-layout", JSON.stringify(layout)); } catch { /* Device preferences are optional. */ }
  currentPage = 0; syncLayout(); paint();
}
function showPageHint() {
  clearTimeout(pageHintTimer);
  $("page-dots").classList.add("is-awake");
  pageHintTimer = setTimeout(() => $("page-dots").classList.remove("is-awake"), 1300);
}
function applyFeatures() {
  // Controls appears only when its sheet would have at least one card (6.5).
  const controls = feature("controls") && controlsSheetHtml() !== "";
  $("drawer-controls").hidden = !controls;
  $("controls-open").hidden = !controls;
  $("tab-controls").hidden = !feature("controls");
  $("drawer-capture").hidden = !feature("capture");
  $("drawer-input").hidden = !feature("input");
  $("drawer-media").hidden = !showMediaButton(caps());
  $("drawer-fullscreen").hidden = !showFullscreenButton({ native: readNative() !== null, fullscreenEnabled: document.fullscreenEnabled === true });
  syncPowerButtons();
}
function controlsSheetHtml() {
  return renderControls(state.verbs, state.allowDestructive, { power: powerCaps(caps()), kind: computerKind(state.platform) });
}
// Power verbs the host doesn't offer stay out of the picker too (5.6).
function pickerVerbs() {
  const power = powerCaps(caps());
  return (state.verbs || []).filter((verb) => !POWER_VERBS.has(verb) || offersPower(power, verb));
}
// The drawer's power group sits beside the computer row (5.5).
function syncPowerButtons() {
  const power = powerCaps(caps());
  const entry = shutdownEntry(power);
  const labels = powerLabels(computerName(), entry);
  for (const [id, shown, label] of [["power-lock", Boolean(power.lock), labels.lock], ["power-sleep", Boolean(power.sleep), labels.sleep], ["power-shutdown", Boolean(entry), labels.shutdown]]) {
    $(id).hidden = !shown;
    $(id).disabled = !online;
    $(id).setAttribute("aria-label", label);
  }
  $("power-shutdown-label").textContent = entry?.label || "Shut down";
  $("drawer-power").hidden = !(power.lock || power.sleep || entry);
}
function platformLabel() {
  return { macos: "Mac", windows: "Windows" }[state.platform] || state.platformName || "Computer";
}
// The drawer's connection row: plain text in a browser, the switch-computer
// button inside a native shell that offers one. Read at use time, since native
// may inject WinDockNative after this module runs.
function syncNative() {
  const native = readNative();
  const name = displayName(native, state.hostName || state.platformName, "Your computer");
  const row = document.querySelector(".drawer-connection");
  if (wantsSwitcher(native) && !row.classList.contains("has-switch")) {
    row.classList.add("has-switch");
    row.parentElement.classList.add("has-switch");
    row.innerHTML = renderSwitchRow({ name, connState: $("conn").dataset.state, connText: $("conn").textContent });
    row.firstElementChild.addEventListener("click", () => { $("drawer").close(); postToNative(window, { type: "switch" }); });
  }
  $("drawer-host").textContent = name;
}
function announceReady() {
  if (!readySent && paired) readySent = postToNative(window, { type: "ready", switcher: true });
}
// The dock as rendered: live running state, close buttons, the Play/Pause
// glyph and the pinned Sleep tile's arming (DOCK-CONTROLS 5.1, 6.1, 6.2).
function dockView() {
  const running = new Set(state.running.map((app) => app.id));
  const power = powerCaps(caps());
  const offline = offlineVisible;
  const name = computerName();
  return { ...state, tiles: state.tiles.map((tile) => {
    if (tile.kind === "spacer") return tile;
    if (tile.kind === "app") {
      const view = { ...tile, running: running.has(tile.id) && !offline, available: !unavailableIds.has(tile.id) };
      const target = view.running && closeTarget(view, { features: state.features, running: state.running, editing, offline, enabled: layout.closeButtons });
      if (target) view.close = { count: target.count, state: closeStates.get(tileKey(tile)) || "rest", fresh: paintedOnce && !previousRunning.has(tile.id) };
      return view;
    }
    // A pinned playlist plays only while this computer has a connected Spotify account.
    if (tile.kind === "spotify") return { ...tile, available: spPlayable() };
    const view = { ...tile, available: feature("controls") && (!POWER_VERBS.has(tile.verb) || offersPower(power, tile.verb)) };
    if (tile.verb === "media-play-pause") view.playing = media?.active === true && media.playing === true;
    if (tile.verb === "sleep") view.arm = { armed: arming.isArmed(tileKey(tile)), text: "Sleep", icon: "moon", label: "Confirm: put " + name + " to sleep" };
    return view;
  }) };
}
// Re-rendering replaces the buttons; keep keyboard focus on the same control.
function rememberFocus(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el)) return null;
  return { close: el.dataset?.closeFor, tile: el.dataset?.tileKey || el.dataset?.closeFor };
}
function restoreFocus(root, focus) {
  if (!focus) return;
  const all = Array.from(root.querySelectorAll("[data-close-for], [data-tile-key]"));
  const target = focus.close && all.find((el) => el.dataset.closeFor === focus.close) || all.find((el) => el.dataset.tileKey === focus.tile);
  target?.focus({ preventScroll: true });
}
function paint() {
  applyFeatures();
  const view = dockView();
  const pages = pageCount(state.tiles, layout, editing);
  currentPage = Math.min(currentPage, pages - 1);
  const html = renderPages(view, layout, editing);
  // Identical snapshots leave the DOM alone, so an armed or fading close
  // button (and its focus) is never reset by an unrelated broadcast.
  if (html !== lastDockHtml) {
    const focus = rememberFocus($("dock"));
    $("dock").innerHTML = html;
    lastDockHtml = html;
    restoreFocus($("dock"), focus);
  }
  previousRunning = new Set(view.tiles.filter((tile) => tile.kind === "app" && tile.running).map((tile) => tile.id));
  paintedOnce = true;
  $("dock").classList.toggle("is-editing", editing);
  $("dock").scrollTo({ left: currentPage * $("dock").clientWidth, behavior: "instant" });
  $("host-name").textContent = state.hostName || state.platformName || "Your computer";
  // Icon geometry differs per host (macOS icons carry a transparent margin): the close badge follows it.
  if (state.platform) document.documentElement.dataset.platform = state.platform; else delete document.documentElement.dataset.platform;
  syncNative();
  document.body.classList.toggle("is-arranging", editing);
  $("edit-done").hidden = !layout.immersive || !editing || !paired;
  $("drawer-edit").innerHTML = icon(editing ? "check" : "edit") + "<span>" + (editing ? "Done" : "Arrange") + "</span>";
  $("dock-title").textContent = editing ? "A place for everything." : "Make yourself at home.";
  $("edit-hint").textContent = editing ? "Drag to move · Tap an icon for options · Done to finish" : "Hold an icon to arrange your space";
  $("edit").setAttribute("aria-pressed", String(editing));
  $("edit").setAttribute("aria-label", editing ? "Done editing" : "Edit dock");
  $("edit").innerHTML = icon(editing ? "check" : "edit") + "<span>" + (editing ? "Done" : "Edit") + "</span>";
  $("page-dots").innerHTML = Array.from({ length: pages }, (_, i) => '<button class="page-dot" type="button" data-page="' + i + '" aria-label="Go to page ' + (i + 1) + '"' + (i === currentPage ? ' aria-current="page"' : "") + '></button>').join("");
  syncPill();
  syncSpotify();
}
function pageTo(page, smooth = true) {
  if (page !== currentPage) arming.disarm("page");
  currentPage = Math.max(0, Math.min(pageCount(state.tiles, layout, editing) - 1, page));
  $("dock").scrollTo({ left: currentPage * $("dock").clientWidth, behavior: smooth ? "smooth" : "instant" });
  if (smooth) showPageHint();
}
function enterEditing() { if (saving) return; arming.disarm("arrange"); editing = true; paint(); }
async function commitTiles(tiles, previous = state.tiles) {
  if (saving) throw new Error("Wait for your last change to finish.");
  saving = true;
  state = { ...state, tiles };
  paint();
  try {
    const saved = await api("/api/tiles", { method: "PUT", body: JSON.stringify({ tiles: toWireTiles(tiles) }) });
    state = { ...state, tiles: saved.tiles };
    paint();
  } catch (err) { state = { ...state, tiles: previous }; paint(); throw err; }
  finally { saving = false; }
}
function connect() {
  if (!paired || socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(scheme + "//" + location.host);
  socket = ws;
  ws.onopen = () => setConn(true);
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    setConn(false);
    if (paired) reconnectTimer = setTimeout(async () => {
      try { await refresh(); connect(); } catch (error) { if (paired) reconnectTimer = setTimeout(connect, 2000); }
    }, 2000);
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type !== "snapshot") return;
      absorbState(msg);
      state = { ...msg, tiles: editing || saving || gesture?.dragging ? state.tiles : msg.tiles };
      if (!gesture?.dragging) paint();
    } catch { /* Ignore malformed frames. */ }
  };
}
async function refresh() {
  const fresh = await api("/api/state");
  absorbState(fresh);
  state = { ...fresh, tiles: editing || saving || gesture?.dragging ? state.tiles : fresh.tiles };
  if (!gesture?.dragging) paint();
  if (mediaCaps(caps()).available) await mediaPoller.refresh().catch(() => {});
  if (feature("capture")) await refreshCapture().catch(() => {});
}
// ---- power (DOCK-CONTROLS 5.5, 5.6): lock and sleep act at once; shut down
// and restart share the one confirmation. A pinned Sleep tile needs two taps.
async function runPower(verb, { closeDrawer = false } = {}) {
  if (!online) return notify(offlineMessage(), true);
  if (verb === "shutdown" || verb === "restart") return openShutdown();
  if (closeDrawer) $("drawer").close();
  await sendPower(verb);
}
// "ok", "permission" (macOS needs a one-time Automation grant) or "error".
async function sendPower(verb) {
  const memory = expectDisconnect(verb, computerName(), Date.now());
  if (memory) storeExpected(memory);
  try {
    await api("/api/control", { method: "POST", body: JSON.stringify({ verb }) });
    notify(powerToast(verb, sentenceName()));
    return "ok";
  } catch (error) {
    if (error.status === 409) { clearExpected(); return "permission"; }
    // The reply can be lost when the computer goes down first; the pill explains.
    if (!error.status && memory && error.message !== "unauthorized") return "ok";
    clearExpected(); report(error); return "error";
  }
}
let confirmFlow = 0;
function setConfirm(mode, { title, body, primary = "shutdown", restart = false, verb = "shutdown" } = {}) {
  const dialog = $("confirm");
  dialog.dataset.state = mode;
  dialog.dataset.primary = primary;
  $("confirm-icon").innerHTML = icon(mode === "confirm" ? "power" : "shield");
  $("confirm-title").textContent = title;
  $("confirm-description").textContent = body;
  $("confirm-waiting").hidden = mode !== "waiting";
  $("confirm-waiting").classList.remove("is-stopped");
  $("confirm-cancel").textContent = mode === "confirm" ? "Cancel" : "Close";
  $("confirm-restart").hidden = mode !== "confirm" || !restart;
  $("confirm-go").hidden = mode !== "confirm";
  $("confirm-go").textContent = primary === "restart" ? "Restart" : "Shut down";
  $("confirm-settings").hidden = mode !== "denied";
  dialog.dataset.verb = verb;
}
function showConfirm() {
  return new Promise((resolve) => {
    const dialog = $("confirm");
    dialog.returnValue = "";
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
    if (!dialog.open) dialog.showModal();
  });
}
function powerDenied(verb, copy) {
  setConfirm("denied", { title: copy.title, body: "Shut down is turned off on your Mac. Turn on WinDock → System Events in System Settings › Privacy & Security › Automation.", verb });
  if (!$("confirm").open) $("confirm").showModal();
}
// macOS asks once (WinDock → System Events); OK on the Mac carries out the command.
async function powerPermission(verb, copy) {
  const flow = ++confirmFlow;
  const name = computerName();
  setConfirm("waiting", { title: "Allow on your Mac", body: verb === "restart" ? name + " is asking whether WinDock may restart it. Click OK there and it restarts." : name + " is asking whether WinDock may shut it down. Click OK there and it shuts down.", verb });
  if (!$("confirm").open) $("confirm").showModal();
  const stop = setTimeout(() => $("confirm-waiting").classList.add("is-stopped"), 60_000);
  try {
    const { status } = await api("/api/permissions/request", { method: "POST", body: JSON.stringify({ scope: "system-events" }) });
    if (status === "granted") {
      if (flow === confirmFlow && $("confirm").open) $("confirm").close();
      await sendPower(verb);
    } else if (status === "denied" && flow === confirmFlow) powerDenied(verb, copy);
    else $("confirm-waiting").classList.add("is-stopped");
  } catch (error) {
    if (flow === confirmFlow && $("confirm").open) $("confirm").close();
    report(error);
  } finally { clearTimeout(stop); }
}
async function openShutdown() {
  const power = powerCaps(caps());
  const entry = shutdownEntry(power);
  if (!entry) return;
  if (!online) return notify(offlineMessage(), true);
  const copy = shutdownDialog(entry, sentenceName());
  confirmFlow++;
  const offered = [entry.shutdown && "shutdown", entry.restart && "restart"].filter(Boolean);
  if (offered.every((verb) => power[verb] === "denied")) return powerDenied(copy.primary, copy);
  setConfirm("confirm", copy);
  const choice = await showConfirm();
  if (choice !== "shutdown" && choice !== "restart") return;
  $("drawer").close();
  if (power[choice] === "denied") return powerDenied(choice, copy);
  if (power[choice] === "needs-permission") return powerPermission(choice, copy);
  if (await sendPower(choice) === "permission") powerPermission(choice, copy);
}
async function activate(button) {
  if (editing && button.dataset.tileKey) return openTileOptions(button.dataset.tileKey);
  if (button.getAttribute("aria-disabled") === "true") return;
  const { action, key } = button.dataset;
  if (action === "spotify-play") {
    const tile = state.tiles.find((item) => tileKey(item) === button.dataset.tileKey);
    if (!tile) return;
    if (button.classList.contains("is-unavailable")) return notify(SP_COPY.connectFirst(computerName()), "neutral");
    return spPlay({ kind: tile.uri.startsWith("spotify:album:") ? "album" : "playlist", uri: tile.uri, name: tile.label }, { toast: true });
  }
  if (action === "launch" && unavailableIds.has(key) || action === "control" && button.dataset.tileKey && (!feature("controls") || button.classList.contains("is-unavailable"))) {
    const label = state.tiles.find((tile) => tileKey(tile) === button.dataset.tileKey)?.label || "This app";
    return notify(label + " isn't available on " + (state.hostName || "this computer") + " anymore. Hold to arrange, then remove it.", true);
  }
  if (!online) return notify(offlineMessage(), true);
  if (action === "control" && POWER_VERBS.has(key)) {
    // A pinned Sleep tile is the one most likely to be hit by accident: two taps.
    if (key === "sleep" && button.dataset.tileKey) {
      const result = arming.tap(button.dataset.tileKey);
      if (result === "armed") { navigator.vibrate?.(10); announce("Tap again to put " + computerName() + " to sleep."); }
      if (result !== "confirm") return;
    }
    return runPower(key);
  }
  // Transport tiles share the mini player's path and state (optimistic, ordered against polls).
  const transport = action === "control" && { "media-play-pause": media?.active && media.playing ? "pause" : "play", "media-next": "next", "media-previous": "previous" }[key];
  if (transport && mediaCaps(caps()).available && !usesLegacyMedia()) return mediaCommand(transport);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    if (action === "control") {
      const raw = button.dataset.value;
      await api("/api/control", { method: "POST", body: JSON.stringify(raw === undefined ? { verb: key } : { verb: key, value: Number(raw) }) });
      if (key.startsWith("media-")) mediaPoller.refresh().catch(() => {});
      notify("Control sent");
    } else if (action === "launch") {
      const running = state.running.find((item) => item.id === key);
      const title = state.tiles.find((item) => item.id === key)?.label || "App";
      await api(running ? "/api/apps/focus" : "/api/apps/launch", { method: "POST", body: JSON.stringify(running ? { pid: running.pid } : { id: key }) });
      notify((running ? "Brought forward: " : "Opened: ") + title);
    }
  } catch (error) { report(error); }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); }
}

// ---- close a running app (DOCK-CONTROLS 5.1, 9.2) ----
// One armed target at a time, shared by the close buttons and the pinned Sleep tile.
const arming = createArming({ onChange: (armedKey, reason, key) => {
  if (key.startsWith("app:")) { if (reason !== "confirm") setCloseState(key, armedKey === key ? "armed" : "rest"); }
  else paintArmedTile(key, armedKey === key);
} });
function findByData(name, value) {
  return Array.from($("dock").querySelectorAll("[data-" + name + "]")).find((el) => el.getAttribute("data-" + name) === value) || null;
}
function closeTile(key) {
  const id = key.slice(4);
  const tile = state.tiles.find((item) => item.kind === "app" && item.id === id);
  return { id, label: tile?.label || "The app", count: Math.max(1, state.running.filter((app) => app.id === id).length) };
}
// Update one slot in place (so CSS transitions run) and keep the cached markup in step.
function setCloseState(key, phase) {
  if (phase === "rest") closeStates.delete(key); else closeStates.set(key, phase);
  const slot = findByData("slot-key", key);
  if (slot) {
    const { label, count } = closeTile(key);
    const labels = closeLabels(label, count);
    const close = slot.querySelector(".tile__close"), tile = slot.querySelector(".tile");
    slot.dataset.closeState = phase;
    close.setAttribute("aria-label", phase === "armed" ? labels.armed : labels.rest);
    for (const [el, name] of [[close, "aria-busy"], [tile, "aria-busy"], [tile, "aria-disabled"]]) {
      if (phase === "closing") el.setAttribute(name, "true"); else el.removeAttribute(name);
    }
  }
  lastDockHtml = slot ? renderPages(dockView(), layout, editing) : "";
}
function paintArmedTile(key, armed) {
  const tile = findByData("tile-key", key);
  if (tile) {
    tile.dataset.armed = String(armed);
    tile.setAttribute("aria-label", armed ? "Confirm: put " + computerName() + " to sleep" : state.tiles.find((item) => tileKey(item) === key)?.label || "Sleep");
  }
  lastDockHtml = tile ? renderPages(dockView(), layout, editing) : "";
}
function handleCloseTap(button) {
  const key = button.dataset.closeFor;
  if (["closing", "leaving"].includes(closeStates.get(key))) return;
  if (!online) return notify(offlineMessage(), true);
  const result = arming.tap(key);
  if (result === "armed") { navigator.vibrate?.(10); announce(closeLabels(closeTile(key).label).live); }
  else if (result === "confirm") closeApp(key).catch(report);
}
async function closeApp(key) {
  const { id, label } = closeTile(key);
  setCloseState(key, "closing");
  // The host waits up to 5 s for the app to exit; the phone gives up at 8 s.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let status = 0, body = null;
  try { body = await api("/api/apps/close", { method: "POST", body: JSON.stringify({ id }), signal: controller.signal }); status = 200; }
  catch (error) { if (error.message === "unauthorized") return; status = error.status || 0; }
  finally { clearTimeout(timer); }
  const outcome = closeOutcome({ status, body, app: label, computer: computerName() });
  notify(outcome.message, outcome.tone);
  if (!outcome.gone) return setCloseState(key, "rest");
  setCloseState(key, "leaving");
  setTimeout(() => {
    closeStates.delete(key);
    state = { ...state, running: state.running.filter((app) => app.id !== id) };
    paint();
  }, 200);
}

// ---- media (DOCK-CONTROLS 5.2, 5.3, 8.3, 8.4) ----
function legacyTransport() { return mediaCaps({ features: {}, verbs: state.verbs }).transport; }
function usesLegacyMedia() { return mediaCaps(caps()).legacy || mediaLegacyFallback; }
function mediaWanted() {
  if (!mediaCaps(caps()).available) return false;
  return layout.miniPlayer || $("media").open || state.tiles.some((tile) => tile.kind === "control" && tile.verb === "media-play-pause");
}
async function loadMedia(signal) {
  const available = mediaCaps(caps());
  if (!available.available) return null;
  if (!usesLegacyMedia()) {
    try { return normalizeMedia(await api("/api/media", { signal })); }
    catch (error) { if (error.status !== 404) throw error; mediaLegacyFallback = true; }
  }
  return fromNowPlaying((await api("/api/nowplaying", { signal })).nowPlaying, available.transport || legacyTransport());
}
function applyMedia(next) {
  const before = media;
  media = next;
  mediaReceivedAt = Date.now();
  if (permissionUi.asking && pendingPermission(mediaCaps(caps()), media)?.status !== "needed") resetPermissionUi();
  // A new Spotify track: its liked state and the queue come from the account.
  if ($("media").open && isSpotifySource(media) && (before?.title !== media.title || !isSpotifySource(before))) { spLoadStatus(); spLoadQueue({ invalidate: true }); }
  renderMedia(before);
  syncPinnedPlay(before);
}
// The pinned Play/Pause tile reads the same shared `media` as the mini player and the sheet.
function syncPinnedPlay(before) {
  if (Boolean(before?.active && before.playing) !== Boolean(media?.active && media.playing)
    && state.tiles.some((tile) => tile.kind === "control" && tile.verb === "media-play-pause")) paint();
}
function focusKey(node) {
  if (!node?.attributes) return null;
  for (const attr of node.attributes) {
    if (!attr.name.startsWith("data-")) continue;
    return attr.name + "=" + (attr.name === "data-media" && ["play", "pause"].includes(attr.value) ? "toggle" : attr.value);
  }
  return null;
}
// Swap markup only when it changed, keeping focus on the same control.
const swapped = new WeakMap();
function clearHtml(el) { el.innerHTML = ""; swapped.delete(el); }
function swapHtml(el, html) {
  if ((swapped.get(el) ?? "") === html && (html !== "" || !el.innerHTML)) return false;
  const active = el.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  el.innerHTML = html;
  swapped.set(el, html);
  if (active) Array.from(el.querySelectorAll("*")).find((node) => focusKey(node) === active)?.focus({ preventScroll: true });
  return true;
}
function miniDismissKey(player) { return computerName() + "|" + player; }
function renderMedia(before = media) {
  const media_ = mediaCaps(caps());
  const permission = pendingPermission(media_, media);
  const mode = miniPlayerMode({ caps: media_, media, enabled: layout.miniPlayer, offlineVisible: offlineVisible || !paired, dismissed: Boolean(permission && miniDismissed.has(miniDismissKey(permission.player))) });
  const floating = layout.immersive;
  // A drag on the seek line or a held volume button is never interrupted by a re-render.
  if (miniSeek || miniStepper.holding || miniLegacyHold?.active) { if ($("media").open) renderSheet(); return; }
  const volMode = miniVolumeMode(caps());
  const muteMode = volMode ? miniMuteMode(caps()) : null;
  const workspace = $("mini-player").parentElement;
  const showVolume = mode === "player" && miniVolumeShown({ mode: volMode, mute: muteMode, immersive: floating, viewportWidth: window.innerWidth, containerWidth: workspace.clientWidth || window.innerWidth });
  const html = renderMiniPlayer({ mode, media, permission, online, volume: showVolume ? volMode : null, mute: showVolume ? muteMode : null, muted: volume.muted === true });
  // The level is fetched once when the mini player first shows its buttons, if still unknown.
  if (showVolume && volMode === "level" && !miniVolumeFetched && !Number.isFinite(volume.level)) { miniVolumeFetched = true; volumePoller.refresh().catch(() => {}); }
  const target = floating ? $("mini-player") : $("nowplaying");
  const other = floating ? $("nowplaying") : $("mini-player");
  if (other.innerHTML) clearHtml(other);
  clearTimeout(miniLeaveTimer); miniLeaveTimer = null;
  if (!html) {
    const leaving = target.querySelector(".mini");
    if (leaving && floating) {
      // Fade out first, then let the grid take the room back (spec 10).
      leaving.classList.add("is-leaving");
      miniLeaveTimer = setTimeout(() => { clearHtml(target); document.body.classList.remove("has-mini", "has-mini-seek"); }, 150);
    } else { clearHtml(target); document.body.classList.remove("has-mini", "has-mini-seek"); }
  } else {
    const entering = !target.querySelector(".mini:not(.is-leaving)");
    const trackChanged = before?.title !== media?.title || before?.artwork !== media?.artwork;
    if (swapHtml(target, html)) {
      const mini = target.querySelector(".mini");
      if (entering) mini?.classList.add("is-entering");
      else if (trackChanged) mini?.classList.add("is-track");
    } else target.querySelector(".mini")?.classList.remove("is-leaving");
    document.body.classList.toggle("has-mini", floating);
    // The seek row makes the player 20 px taller; the dock reserves that room too.
    document.body.classList.toggle("has-mini-seek", floating && Boolean(target.querySelector(".mini.has-seek")));
    tickMini(true);
  }
  if ($("media").open) renderSheet();
}
// The mini player's seek line follows the same interpolated position as the sheet (8.3).
function miniHost() { return layout.immersive ? $("mini-player") : $("nowplaying"); }
function paintMiniSeek(position, instant) {
  const line = miniHost().querySelector("[data-mini-seek]");
  if (!line || !media?.durationMs || position === null) return;
  if (instant) line.classList.add("is-instant");
  line.style.setProperty("--p", (position / media.durationMs).toFixed(4));
  // The elapsed time follows the line, live while dragging too (it stands in for a label over the thumb).
  const now = line.querySelector("[data-mini-seek-now]");
  if (now) now.textContent = formatTime(position);
  const hit = line.querySelector("[data-mini-seek-hit]");
  if (hit) {
    const aria = seekAria(position, media.durationMs, spokenTime);
    hit.setAttribute("aria-valuemax", String(aria.max));
    hit.setAttribute("aria-valuenow", String(aria.now));
    hit.setAttribute("aria-valuetext", aria.text);
  }
  if (instant) { void line.offsetWidth; line.classList.remove("is-instant"); }
}
function tickMini(instant = false) {
  if (miniSeek) return;
  paintMiniSeek(mediaPosition(media, mediaReceivedAt, Date.now()), instant);
}
function sheetPermission() {
  const permission = pendingPermission(mediaCaps(caps()), media);
  if (!permission || permissionUi.later === permission.player) return null;
  if (permissionUi.player !== permission.player) return permission;
  return { ...permission, status: permissionUi.denied ? "denied" : permission.status, asking: permissionUi.asking, stopped: permissionUi.stopped };
}
function showOnTarget() {
  const appId = media?.source?.appId;
  return appId ? state.running.find((app) => app.id === appId) || null : null;
}
function renderSheet() {
  const media_ = mediaCaps(caps());
  const base = { media, caps: media_, permission: sheetPermission(), online, computer: computerName(), kind: computerKind(state.platform), showOn: Boolean(showOnTarget()), sourcesOpen };
  // Phase B (DOCK-CONTROLS 12): the same sheet grows tabs once an account is
  // connected; the Library, Search and Devices panels replace the player and
  // the volume row, and a footer keeps the track and the device in view.
  const mode = spMode();
  const tab = mode === "tabs" ? sp.tab : "now";
  let content, panel = "", foot = "", volumeShown = true;
  if (mode === "waiting") {
    content = renderMediaSheet({ ...base, brand: spotifyBrand(), body: "" });
    panel = renderSpWaiting({ computer: computerName(), stopped: sp.flow.stopped, online });
    volumeShown = false;
  } else if (mode === "tabs") {
    const tabs = renderSpTabs({ tab, online });
    const button = tab === "now" ? spUpNextButton() : null;
    // The queue panel only stands while its button would: a wider screen or another source closes it.
    if (sp.queueOpen && !button) { sp.queueOpen = false; spQueueLoader.poll(false); }
    if (tab === "now" && sp.queueOpen) {
      content = renderMediaSheet({ ...base, tabs, brand: spotifyBrand(), body: "" });
      panel = renderSpQueuePanel({ items: sp.queue, loaded: sp.queueLoaded, error: sp.queueError, online });
      volumeShown = false;
    } else if (tab === "now") {
      const spotifyNow = isSpotifySource(media);
      const like = spotifyNow && sp.status?.track ? renderLikeButton({ liked: spTrackLiked(), online, busy: sp.likeBusy }) : "";
      const aside = spotifyNow && spWide() ? renderSpUpNext(sp.queue) : "";
      content = renderMediaSheet({ ...base, tabs, brand: spotifyBrand(), like, aside, upNext: renderUpNextButton(button, { online }) });
    } else {
      content = renderMediaSheet({ ...base, tabs, brand: spotifyBrand(), body: "" });
      panel = spPanelHtml(tab);
      volumeShown = false;
    }
    foot = spFooterHtml();
  } else {
    content = renderMediaSheet(base);
    if (mode === "entry") foot = renderSpEntry({ disconnected: sp.disconnected, online });
  }
  const dialog = $("media");
  dialog.classList.toggle("has-tabs", mode === "tabs");
  dialog.classList.toggle("is-queue", mode === "tabs" && tab === "now" && sp.queueOpen);
  dialog.dataset.spTab = mode === "tabs" ? tab : mode;
  swapHtml($("media-content"), content);
  dialog.dataset.playing = String(media?.active === true && media.playing === true);
  if (!volume.dragging) swapHtml($("media-volume"), volumeShown ? renderVolumeRow({ mode: volumeMode(caps()), online }) : "");
  swapSpPanel(panel, tab);
  swapHtml($("media-spotify"), foot);
  tickProgress(true);
  paintVolume(false);
}
// Position between polls is interpolated from the last reply (8.3).
function tickProgress(instant = false) {
  if (!$("media").open || seeking) return;
  const track = $("media-content").querySelector("[data-progress]");
  const position = mediaPosition(media, mediaReceivedAt, Date.now());
  if (!track || position === null) return;
  if (instant || !media.playing) track.classList.add("is-instant");
  track.style.setProperty("--p", (position / media.durationMs).toFixed(4));
  $("media-content").querySelector("[data-progress-time]").textContent = formatTime(position);
  const input = track.querySelector("[data-seek]");
  if (input) { input.value = String(Math.round(position)); input.setAttribute("aria-valuetext", spokenTime(position) + " of " + spokenTime(media.durationMs)); }
  if (track.classList.contains("is-instant")) { void track.offsetWidth; track.classList.remove("is-instant"); }
}
function paintVolume(animate) {
  paintMiniMute();
  const range = $("media-volume").querySelector("[data-volume-range]");
  if (!range) return;
  const known = Number.isFinite(volume.level);
  const level = known ? volume.level : 0;
  range.classList.toggle("is-instant", !animate || volume.dragging);
  range.classList.toggle("is-muted", volume.muted);
  range.style.setProperty("--p", String(level / 100));
  const input = range.querySelector("[data-volume-input]");
  if (!volume.dragging) input.value = String(level);
  input.setAttribute("aria-valuetext", volume.muted ? "Muted" : level + " percent");
  input.disabled = !online || !known;
  $("media-volume").querySelector("[data-volume-value]").textContent = !known ? "–" : volume.muted ? "Muted" : level + "%";
  const mute = $("media-volume").querySelector("[data-volume-mute]");
  mute.innerHTML = icon(volume.muted ? "mute" : "volume");
  mute.setAttribute("aria-label", volume.muted ? "Unmute" : "Mute");
  mute.setAttribute("aria-pressed", String(volume.muted));
  mute.disabled = !online || !known;
}
// The mini player's mute toggle shows the shared state (only a "level" host reports it).
function paintMiniMute() {
  const button = miniHost().querySelector('[data-mini-mute="level"]');
  if (!button) return;
  button.setAttribute("aria-pressed", String(volume.muted === true));
  button.setAttribute("aria-label", volume.muted === true ? "Unmute" : "Mute");
}
const clampLevel = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Math.round(Number(value)))) : null;
function loadVolume(signal) {
  if (!online || (volumeMode(caps()) !== "slider" && miniVolumeMode(caps()) !== "level")) return null;
  return api("/api/volume", { signal });
}
// A poll or a change's reply: applied unless a drag or a held button owns the value.
function applyVolume(fresh) {
  if (!fresh || typeof fresh !== "object" || volume.dragging || volumeThrottle.pending || miniStepper.holding) return;
  if (Number.isFinite(fresh.level)) volume.level = clampLevel(fresh.level);
  if (typeof fresh.muted === "boolean") volume.muted = fresh.muted;
  paintVolume(true);
  const chip = miniHost().querySelector("[data-mini-chip].is-visible");
  if (chip) chip.textContent = miniVolumeChip(volume);
}
const refreshVolume = () => volumePoller.refresh().catch(() => { /* Keep the last value; the next poll retries. */ });
// Changes run through the poller (ordered against polls); a final change's reply becomes the shared state.
async function sendVolume(change, final) {
  try {
    await volumePoller.command(() => api("/api/volume", { method: "POST", body: JSON.stringify(change) }).then((fresh) => (final ? fresh : null)));
  } catch (error) { if (final) { report(error); refreshVolume(); } }
}
// At most one level per 100 ms while dragging, and always the final value (8.4).
const volumeThrottle = createThrottle((level, final) => sendVolume({ level }, final), { intervalMs: 100 });
async function fetchVolumeLevel() {
  if (online) await refreshVolume();
}
// Mute toggle (mini player and Media sheet): optimistic, then the reply reconciles.
// Older hosts only have the mute-toggle verb and no state to show.
function toggleMute(mode) {
  if (!online) return notify(offlineMessage(), true);
  if (mode === "legacy") return api("/api/control", { method: "POST", body: JSON.stringify({ verb: "mute-toggle" }) }).catch(report);
  volume.muted = volume.muted !== true;
  paintVolume(false);
  showMiniChip();
  sendVolume({ muted: volume.muted }, true);
}
function showMiniChip() {
  const chip = miniHost().querySelector("[data-mini-chip]");
  if (!chip) return;
  chip.textContent = miniVolumeChip(volume);
  chip.classList.add("is-visible");
  clearTimeout(miniChipTimer);
  miniChipTimer = setTimeout(() => chip.classList.remove("is-visible"), CHIP_HIDE_MS);
}
function legacyVolume(direction) {
  return () => api("/api/control", { method: "POST", body: JSON.stringify({ verb: direction > 0 ? "volume-up" : "volume-down" }) }).catch(report);
}
let miniVolumeDown = false;
async function pressMiniVolume(button) {
  const direction = button.dataset.miniVol === "up" ? 1 : -1;
  miniVolumeDown = true;
  if (button.closest("[data-mini-vol-mode]")?.dataset.miniVolMode === "legacy") {
    miniLegacyHold?.stop();
    miniLegacyHold = createHoldRepeat(legacyVolume(direction));
    miniLegacyHold.start();
    return;
  }
  if (!Number.isFinite(volume.level)) {
    await fetchVolumeLevel();
    if (!Number.isFinite(volume.level)) return;
    // Released while the level loaded: still one step, but no hold.
    if (!miniVolumeDown) { unmuteOnRaise(direction); miniStepper.press(direction); miniStepper.release(); return; }
  }
  unmuteOnRaise(direction);
  miniStepper.press(direction);
}
function unmuteOnRaise(direction) {
  if (direction <= 0 || volume.muted !== true || miniMuteMode(caps()) !== "level") return;
  volume.muted = false;
  // At 100 the step sends no level, so the unmute goes on its own.
  if (stepVolume(volume.level, 1) === volume.level) { paintVolume(false); showMiniChip(); sendVolume({ muted: false }, true); }
  else unmuteWithLevel = true;
}
function releaseMiniVolume() {
  miniVolumeDown = false;
  const wasHolding = miniStepper.holding || miniLegacyHold?.active;
  miniStepper.release();
  miniLegacyHold?.stop();
  if (wasHolding) renderMedia();
}
function openMedia() {
  if (!paired) return;
  $("drawer").close();
  sourcesOpen = false;
  renderSheet();
  if (!$("media").open) $("media").showModal();
  mediaPoller.refresh().catch(() => {});
  refreshVolume();
  spOnOpen();
}
function resetPermissionUi() {
  clearTimeout(permissionUi.timer);
  permissionUi = { ...permissionUi, player: null, asking: false, stopped: false, denied: false, timer: null };
}
async function askPermission(player) {
  resetPermissionUi();
  permissionUi = { ...permissionUi, player, asking: true, later: null };
  permissionUi.timer = setTimeout(() => { permissionUi.stopped = true; renderSheet(); }, 60_000);
  renderSheet();
  try {
    const { status } = await api("/api/permissions/request", { method: "POST", body: JSON.stringify({ scope: player }) });
    if (permissionUi.player !== player) return;
    if (status === "granted") { resetPermissionUi(); mediaPoller.refresh().catch(() => {}); }
    else if (status === "denied") { clearTimeout(permissionUi.timer); permissionUi = { ...permissionUi, asking: false, denied: true }; }
    else permissionUi.stopped = true;
  } catch (error) { resetPermissionUi(); report(error); }
  renderMedia();
}
async function mediaCommand(action, value) {
  if (!online) return notify(offlineMessage(), true);
  const legacy = usesLegacyMedia();
  // Optimistic: the control's own state is the feedback (9.4); the reply or the next poll corrects it.
  if (media?.active || action === "play") {
    const patch = { play: { playing: true }, pause: { playing: false }, shuffle: { shuffle: !media?.shuffle }, repeat: { repeat: { off: "all", all: "one", one: "off" }[media?.repeat] || "all" } }[action];
    if (patch && media) {
      const before = media;
      if ("playing" in patch) media = { ...media, positionMs: mediaPosition(media, mediaReceivedAt, Date.now()) ?? media.positionMs };
      media = { ...media, ...patch };
      mediaReceivedAt = Date.now();
      renderMedia(before);
      syncPinnedPlay(before);
    }
  }
  const body = action === "shuffle" ? { action, value: media?.shuffle === true } : action === "repeat" ? { action, value: media?.repeat || "off" } : value === undefined ? { action } : { action, value };
  // Through the poller: polls that started before the reply can't overwrite the
  // optimistic state, and the reply (when it has state) becomes the shared state.
  try {
    if (legacy) {
      const verb = { play: "media-play-pause", pause: "media-play-pause", next: "media-next", previous: "media-previous" }[action];
      if (!verb) return;
      await mediaPoller.command(() => api("/api/control", { method: "POST", body: JSON.stringify({ verb }) }).then(() => null));
      setTimeout(() => mediaPoller.refresh().catch(() => {}), 350);
    } else {
      const fresh = await mediaPoller.command(() => api("/api/media", { method: "POST", body: JSON.stringify(body) })
        .then((reply) => (reply && typeof reply === "object" && "source" in reply ? normalizeMedia(reply) : null)));
      if (!fresh) mediaPoller.refresh().catch(() => {});
    }
  } catch (error) {
    mediaPoller.refresh().catch(() => {});
    if (error.status === 409 || error.message === "unauthorized") return;
    const player = media?.source?.name;
    report(player && error.status ? Object.assign(new Error(computerName() + " couldn't reach " + player + ". Try again."), { status: error.status }) : error);
  }
}

// ---- Spotify account (DOCK-CONTROLS 6.4, 12): tabs, login on the computer, playlist tiles ----
const spAccount = () => spotifyAccount(state.features);
const spPremium = () => spAccount()?.premium !== false;
const spWide = () => window.innerWidth >= UP_NEXT_WIDE_MIN;
function spMode() {
  return spotifyMode({ account: spAccount(), media, installed: spotifyInstalled(state.features), disconnected: sp.disconnected || sp.notConnected, waiting: Boolean(sp.flow) });
}
function spPlayable() { return Boolean(spAccount()?.connected) && !sp.disconnected && !sp.notConnected; }
function renderSheetIfOpen() { if ($("media").open) renderSheet(); }
function spIsPlaying() { return isSpotifySource(media) ? media.playing === true : sp.status?.playing === true; }
// The context playing now ("Playing" row): the account's answer, else the last one this phone started.
function spPlayingUri() { return spIsPlaying() ? sp.status?.contextUri || sp.lastContext : null; }
function spResetData() {
  sp.status = null; sp.liked = null; sp.library = null; sp.likedTotal = null; sp.likedFirst = null; sp.devices = null; sp.devicesError = null;
  sp.queue = []; sp.queueLoaded = false; sp.queueError = null; sp.queueOpen = false;
  spQueueLoader.poll(false); spQueueLoader.cancel();
  sp.lastContext = null; sp.search = { text: "", query: "", resultsQuery: "", results: null, loading: false, error: null };
  spSearch.cancel();
}
// The snapshot is the source of truth for the account: react when it connects or goes away.
function syncSpotify() {
  const account = spAccount();
  const was = sp.account;
  sp.account = account;
  const connected = Boolean(account?.connected), wasConnected = Boolean(was?.connected);
  if (connected && !wasConnected) {
    const landed = Boolean(sp.flow) || sp.disconnected || sp.notConnected;
    clearTimeout(sp.flow?.timer);
    sp.flow = null; sp.disconnected = false; sp.notConnected = false;
    spResetData();
    // Login finished on the computer: the sheet switches to the tabs on its own (frame 20 → 21).
    if (landed) sp.tab = "library";
    if ($("media").open) {
      renderSheet();
      spOnOpen();
      if (landed) document.getElementById("sp-tab-library")?.focus({ preventScroll: true });
    }
  } else if (!connected && wasConnected) {
    sp.tab = "now"; sp.notConnected = false;
    spResetData();
    renderSheetIfOpen();
  } else if (!account && sp.flow) {
    clearTimeout(sp.flow.timer); sp.flow = null;
    renderSheetIfOpen();
  } else if (account?.premium !== was?.premium) renderSheetIfOpen();
}
// Map a failed call to its copy; a revoked token turns the tabs back into "Connect again".
function spHandleError(error, quiet = false) {
  if (error?.message === "unauthorized" || error?.name === "AbortError") return { kind: "quiet", message: "" };
  const info = spotifyError(error, computerName());
  // A revoked sign-in shows "Spotify disconnected · Connect again"; "not connected" shows the plain connect row.
  if ((info.kind === "disconnected" && !sp.disconnected) || (info.kind === "not-connected" && !sp.notConnected && !sp.disconnected)) {
    if (info.kind === "disconnected") sp.disconnected = true; else sp.notConnected = true;
    sp.tab = "now";
    spResetData();
    paint();
    renderSheetIfOpen();
  }
  if (!quiet) notify(info.message, info.kind === "busy" || info.kind === "device" ? "neutral" : true);
  return info;
}
function spOnOpen() {
  if (spMode() !== "tabs" || !online) return;
  spLoadStatus();
  spLoadDevices();
  if (sp.tab === "library" && !sp.library?.loaded && !sp.library?.loading) spLoadLibrary();
  if (sp.tab === "now") spLoadQueue();
}
async function spLoadStatus() {
  if (spMode() !== "tabs" || !online) return;
  try { sp.status = normalizeSpotifyStatus(await api("/api/spotify/status")); }
  catch (error) { spHandleError(error, true); return; }
  renderSheetIfOpen();
  spLoadLiked();
}
// The heart's state for the track playing now (GET /api/spotify/like).
async function spLoadLiked() {
  const track = sp.status?.track;
  if (!track || sp.liked?.trackId === track.id || sp.likeBusy) return;
  try {
    const reply = await api("/api/spotify/like?trackId=" + encodeURIComponent(track.id));
    if (sp.status?.track?.id === track.id && !sp.likeBusy) sp.liked = { trackId: track.id, liked: reply?.liked === true };
  } catch (error) { spHandleError(error, true); return; }
  renderSheetIfOpen();
}
const spTrackLiked = () => Boolean(sp.status?.track && sp.liked?.trackId === sp.status.track.id && sp.liked.liked);
async function spLoadDevices() {
  if (spMode() !== "tabs" || !online || sp.devicesLoading) return;
  sp.devicesLoading = true; sp.devicesError = null;
  renderSheetIfOpen();
  try { sp.devices = normalizeDevices(await api("/api/spotify/devices")); }
  catch (error) { sp.devicesError = spHandleError(error, true).message || null; }
  finally { sp.devicesLoading = false; }
  renderSheetIfOpen();
}
// Up next (GET /api/spotify/queue): a list beside the player on wide screens; on
// narrower ones an "Up next · n" button opens it as a panel in place of the
// player. See + add only: Spotify's Web API can't remove or reorder.
// Single-flight; a track change or an add discards older answers; 15 s refresh
// while the panel is on screen. A 404 (older host) hides Up next for good.
const spQueueLoader = createQueueLoader({
  load: () => api("/api/spotify/queue"),
  isPolling: () => sp.queueOpen && $("media").open && !document.hidden && online && spMode() === "tabs",
  onState: (next) => {
    if (next.loading) return; // what is on screen stays until the answer lands
    if (next.unsupported) { sp.queueSupported = false; sp.queue = []; sp.queueOpen = false; spQueueLoader.poll(false); }
    else if (next.error) {
      const info = spHandleError(next.error, true);
      if (info.kind === "quiet") return;
      sp.queueError = info.kind === "busy" ? SP_COPY.busy : SP_COPY.queueError;
    } else { sp.queue = next.items; sp.queueLoaded = true; sp.queueError = null; }
    renderSheetIfOpen();
  },
});
function spLoadQueue({ invalidate = false } = {}) {
  if (!sp.queueSupported || spMode() !== "tabs" || !online) return;
  spQueueLoader.refresh({ invalidate }).catch(() => {});
}
function spUpNextButton() {
  return upNextButton({ mode: spMode(), supported: sp.queueSupported, wide: spWide(), spotifyNow: isSpotifySource(media), loaded: sp.queueLoaded, count: sp.queue.length });
}
// The panel swaps in for the player in the same sheet; Back returns from it first.
function spOpenQueue() {
  if (sp.tab !== "now" || !spUpNextButton()) return;
  sp.queueOpen = true;
  renderSheet();
  $("sp-panel").scrollTop = 0;
  // The swap eases in once, on opening; later refreshes of the list don't replay it.
  $("sp-panel").querySelector(".sp-queue")?.classList.add("is-entering");
  $("sp-panel").querySelector("[data-sp-queue-back]")?.focus({ preventScroll: true });
  spLoadQueue();
  spQueueLoader.poll(true);
}
function spCloseQueue({ focus = true } = {}) {
  if (!sp.queueOpen) return;
  sp.queueOpen = false;
  spQueueLoader.poll(false);
  renderSheetIfOpen();
  if (focus) $("media-content").querySelector("[data-sp-queue-open]")?.focus({ preventScroll: true });
}
// Library: Liked Songs (its count) and the first page of playlists, then a page more near the end.
async function spLoadLibrary(more = false) {
  const current = sp.library;
  if (current?.loading || spMode() !== "tabs" || !online) return;
  if (more && (!current?.loaded || current.next === null)) return;
  const offset = more ? current.next : 0;
  const keep = more ? current : { items: [], next: 0, loaded: false };
  sp.library = { ...keep, loading: true, error: null };
  renderSheetIfOpen();
  try {
    const [page, liked] = await Promise.all([
      api("/api/spotify/playlists?offset=" + offset + "&limit=" + PAGE_SIZE),
      more ? null : api("/api/spotify/liked?offset=0&limit=1").catch(() => null),
    ]);
    sp.library = mergePage(more ? current : null, normalizePage(page, "playlist", offset));
    if (liked) {
      const page = normalizePage(liked, "track");
      sp.likedTotal = page.total;
      sp.likedFirst = page.items[0]?.uri || null;
    }
  } catch (error) {
    sp.library = { ...keep, loading: false, error: spHandleError(error, true).message || "Couldn't load your library." };
  }
  renderSheetIfOpen();
  requestAnimationFrame(spMaybeMore);
}
function spMaybeMore() {
  const panel = $("sp-panel");
  if (!$("media").open || sp.tab !== "library" || spMode() !== "tabs") return;
  const library = sp.library;
  if (!library?.loaded || library.loading || library.error || library.next === null) return;
  if (panel.scrollHeight - panel.scrollTop - panel.clientHeight < 240) spLoadLibrary(true);
}
function spPanelHtml(tab) {
  const premium = spPremium();
  if (tab === "library") return renderSpLibrary({ likedTotal: sp.likedTotal, playlists: sp.library, playingUri: spPlayingUri(), premium, online });
  if (tab === "search") return renderSpSearchPanel({ premium, online });
  if (tab === "devices") return renderSpDevices({ devices: sp.devices, loading: sp.devicesLoading, error: sp.devicesError, premium, online, hostName: state.hostName || "", playing: spIsPlaying() });
  return "";
}
// The search field survives re-renders: its text and focus come back if the panel is rebuilt.
function swapSpPanel(html, tab) {
  const panel = $("sp-panel");
  const changed = swapHtml(panel, html);
  $("media").classList.toggle("is-search", html !== "" && tab === "search");
  if (tab !== "search" || !html) return;
  const input = panel.querySelector("[data-sp-search]");
  if (changed && input) input.value = sp.search.text;
  paintSpResults();
}
function paintSpResults() {
  const el = $("sp-panel").querySelector("[data-sp-results]");
  if (!el) return;
  const s = sp.search;
  swapHtml(el, renderSpResults({ query: s.results ? s.resultsQuery : s.query, results: s.results, loading: s.loading, error: s.error, premium: spPremium(), online, playingUri: spPlayingUri() }));
}
function spFooterHtml() {
  const local = isSpotifySource(media);
  const known = sp.status?.track;
  const track = local ? { title: media.title, artist: media.artist, artwork: media.artwork } : known ? { title: known.name, artist: known.artists, image: known.image } : null;
  const device = activeDevice(sp.devices) || sp.status?.device || null;
  return renderSpFooter({ track, playing: spIsPlaying(), canPlay: local && media.controls?.playPause !== false, device, online });
}
// Search: 300 ms after the last keystroke; a newer query cancels the older request.
const spSearch = createSearch({
  load: (query, signal) => api("/api/spotify/search?q=" + encodeURIComponent(query) + "&types=track,artist,album,playlist&limit=10", { signal }),
  onState: (next) => {
    const error = next.error ? spHandleError(next.error, true).message || "Search didn't work. Try again." : null;
    sp.search = { ...sp.search, query: next.query, loading: next.loading, error };
    if ("results" in next) sp.search = { ...sp.search, results: next.results, resultsQuery: next.query };
    if (!next.query) sp.search = { ...sp.search, results: null, resultsQuery: "" };
    paintSpResults();
  },
});
function spSelectTab(tab, { focus = "tab" } = {}) {
  if (spMode() !== "tabs") return;
  if (sp.queueOpen) { sp.queueOpen = false; spQueueLoader.poll(false); }
  sp.tab = spotifyTab(tab);
  renderSheet();
  $("sp-panel").scrollTop = 0;
  $("media").scrollTop = 0;
  if (focus === "tab") document.getElementById("sp-tab-" + sp.tab)?.focus({ preventScroll: true });
  if (focus === "search") $("sp-panel").querySelector("[data-sp-search]")?.focus({ preventScroll: true });
  if (sp.tab === "library" && !sp.library?.loaded && !sp.library?.loading) spLoadLibrary();
  if (sp.tab === "devices") spLoadDevices();
  if (sp.tab === "now") spLoadQueue();
}
function spStartFlow() {
  clearTimeout(sp.flow?.timer);
  sp.flow = { stopped: false, timer: setTimeout(() => { if (sp.flow) { sp.flow.stopped = true; renderSheetIfOpen(); } }, WAIT_STOP_MS) };
  renderSheetIfOpen();
}
function spStopFlow() { clearTimeout(sp.flow?.timer); sp.flow = null; renderSheetIfOpen(); }
// Login happens on the computer: the host opens its browser; the snapshot says when it's done.
async function spConnect() {
  if (!online) return notify(offlineMessage(), true);
  const first = !sp.flow;
  spStartFlow();
  if (first) $("sp-panel").querySelector("[data-sp-reopen]")?.focus({ preventScroll: true });
  try { await api("/api/spotify/connect", { method: "POST", body: "{}" }); }
  catch (error) { spStopFlow(); spHandleError(error); }
}
async function spPlay(item, { toast = false } = {}) {
  if (!online) return notify(offlineMessage(), true);
  if (!spPremium()) return notify(SP_COPY.premium, true);
  const body = playBody(item.kind === "liked" ? { ...item, firstUri: sp.likedFirst } : item);
  if (!body) return;
  try {
    await api("/api/spotify/play", { method: "POST", body: JSON.stringify(body) });
    const context = item.kind === "liked" ? LIKED_CONTEXT : body.contextUri;
    if (context) {
      sp.lastContext = context;
      if (sp.status) sp.status = { ...sp.status, contextUri: context };
    }
    if (toast) notify(SP_COPY.playingName(item.name)); else announce(SP_COPY.playingName(item.name));
    renderSheetIfOpen();
    mediaPoller.refresh().catch(() => {});
    setTimeout(spLoadStatus, 700);
  } catch (error) { spHandleError(error); }
}
async function spQueue(item) {
  if (!online) return notify(offlineMessage(), true);
  if (!spPremium()) return notify(SP_COPY.premium, true);
  try {
    await api("/api/spotify/queue", { method: "POST", body: JSON.stringify({ uri: item.uri }) });
    notify(SP_COPY.queued);
    spLoadQueue({ invalidate: true });
  } catch (error) { spHandleError(error); }
}
async function spTransfer(id) {
  const device = sp.devices?.find((entry) => entry.id === id);
  if (!device || device.active || device.restricted) return;
  if (!online) return notify(offlineMessage(), true);
  if (!spPremium()) return notify(SP_COPY.premium, true);
  const before = sp.devices;
  sp.devices = sp.devices.map((entry) => ({ ...entry, active: entry.id === id }));
  renderSheetIfOpen();
  try {
    await api("/api/spotify/transfer", { method: "POST", body: JSON.stringify({ deviceId: id }) });
    announce("Playing on " + device.name);
    setTimeout(spLoadDevices, 800);
    mediaPoller.refresh().catch(() => {});
  } catch (error) { sp.devices = before; renderSheetIfOpen(); spHandleError(error); }
}
async function spToggleLike() {
  const track = sp.status?.track;
  if (!track || sp.likeBusy) return;
  if (!online) return notify(offlineMessage(), true);
  const liked = !spTrackLiked();
  sp.liked = { trackId: track.id, liked };
  sp.likeBusy = true;
  renderSheetIfOpen();
  try {
    await api("/api/spotify/like", { method: "POST", body: JSON.stringify({ trackId: track.id, liked }) });
    announce(liked ? "Saved to Liked Songs" : "Removed from Liked Songs");
  } catch (error) {
    if (sp.liked?.trackId === track.id) sp.liked = { trackId: track.id, liked: !liked };
    spHandleError(error);
  } finally { sp.likeBusy = false; renderSheetIfOpen(); }
}
function spItemFrom(el) {
  const d = el.dataset;
  return { uri: d.spUri, kind: d.spKind, name: d.spName || "Spotify", image: d.spImage || null, sub: d.spSub || "" };
}
// Long-press: a song goes to the queue; a playlist or album opens Play / Add to dock.
function spLongPress(el) {
  const item = spItemFrom(el);
  if (item.kind === "track") return spQueue(item);
  if (isTileUri(item.uri)) spOpenMenu(item);
}
function spOpenMenu(item) {
  sp.menuItem = item;
  $("sp-menu-art").innerHTML = spotifyCover(item.image, item.name);
  $("sp-menu-title").textContent = item.name;
  $("sp-menu-sub").textContent = item.sub;
  $("sp-menu-actions").innerHTML = renderSpMenuActions(item, { premium: spPremium() });
  if (!$("sp-menu").open) $("sp-menu").showModal();
}
// Disconnect from the phone (DELETE /api/spotify/account), behind the shared confirmation.
async function spDisconnect() {
  if (!online) return notify(offlineMessage(), true);
  setConfirm("confirm", { title: "Disconnect Spotify?", body: "Playlists, search and devices stop working on every phone until Spotify is connected again on " + computerName() + ".", primary: "disconnect" });
  $("confirm-icon").innerHTML = icon("close");
  $("confirm-go").textContent = "Disconnect";
  confirmFlow++;
  if (await showConfirm() !== "disconnect") return;
  try {
    await api("/api/spotify/account", { method: "DELETE" });
    sp.tab = "now";
    notify("Spotify disconnected");
    renderSheetIfOpen();
  } catch (error) { spHandleError(error); }
}
async function spAddToDock(item) {
  const tile = spotifyTile(item);
  if (!tile) return;
  if (hasTile(state.tiles, tileKey(tile))) return notify(SP_COPY.alreadyOnDock, "neutral");
  if (realTiles(state.tiles).length >= MAX_TILES) return notify("Your dock is full. Remove a tile before adding another.", true);
  if (!online) return notify(offlineMessage(), true);
  try { await commitTiles(addSpotifyTile(state.tiles, tile)); notify(item.name + " added to your dock"); }
  catch (error) { report(error); }
}
// Spotify controls in the Media sheet and its menu; true when the click was one of them.
function handleSpotifyClick(el) {
  const data = el.dataset;
  if (data.spTab) spSelectTab(data.spTab, { focus: data.spTab === "search" ? "search" : "tab" });
  else if (data.spGoto) spSelectTab(data.spGoto);
  else if ("spConnect" in data || "spReopen" in data) spConnect();
  else if ("spCancel" in data) { spStopFlow(); $("media-spotify").querySelector("[data-sp-connect]")?.focus({ preventScroll: true }); }
  else if ("spLike" in data) spToggleLike();
  else if ("spQueueOpen" in data) spOpenQueue();
  else if ("spQueueBack" in data) spCloseQueue();
  else if ("spAddSongs" in data) spSelectTab("search", { focus: "search" });
  else if (data.spUri) {
    if (el.getAttribute("aria-disabled") === "true") notify(SP_COPY.premium, true);
    else spPlay(spItemFrom(el));
  } else if (data.spDevice) {
    if (el.getAttribute("aria-disabled") === "true") notify(SP_COPY.premium, true);
    else spTransfer(data.spDevice);
  } else if ("spDisconnect" in data) spDisconnect();
  else if (data.spRetry === "library") spLoadLibrary(Boolean(sp.library?.loaded));
  else if (data.spRetry === "devices") spLoadDevices();
  else if (data.spRetry === "queue") spLoadQueue();
  else if (data.spRetry === "search") spSearch.input(sp.search.text);
  else if (data.spMenu) {
    const item = sp.menuItem;
    $("sp-menu").close();
    if (!item) return true;
    if (data.spMenu === "play") spPlay(item);
    else if (data.spMenu === "queue") spQueue(item);
    else if (data.spMenu === "dock") spAddToDock(item);
  } else return false;
  return true;
}
let spPress = null, spPointerType = "mouse";
function spCancelPress() { if (spPress) clearTimeout(spPress.timer); spPress = null; }
$("sp-panel").addEventListener("pointerdown", (event) => {
  spPointerType = event.pointerType || "mouse";
  spCancelPress();
  const row = event.target.closest("[data-sp-uri]");
  if (!row || row.disabled || event.button !== 0) return;
  spPress = { id: event.pointerId, x: event.clientX, y: event.clientY, row, timer: setTimeout(() => {
    spPress = null;
    suppressClickUntil = Date.now() + 600;
    navigator.vibrate?.(10);
    spLongPress(row);
  }, LONG_PRESS_MS) };
});
document.addEventListener("pointermove", (event) => {
  if (spPress && event.pointerId === spPress.id && Math.hypot(event.clientX - spPress.x, event.clientY - spPress.y) > 10) spCancelPress();
});
document.addEventListener("pointerup", spCancelPress);
document.addEventListener("pointercancel", spCancelPress);
$("sp-panel").addEventListener("scroll", () => { spCancelPress(); spMaybeMore(); }, { passive: true });
// Touch long-press is ours; a right click or the context-menu key does the same.
$("sp-panel").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const row = event.target.closest("[data-sp-uri]");
  if (row && !row.disabled && spPointerType !== "touch") spLongPress(row);
});
$("sp-panel").addEventListener("input", (event) => {
  const input = event.target.closest("[data-sp-search]");
  if (!input) return;
  sp.search.text = input.value;
  spSearch.input(input.value);
});
$("sp-panel").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.closest("[data-sp-search]")) { event.preventDefault(); spSearch.flush(); }
});
// Tabs: arrow keys, Home and End move between them (automatic activation).
$("media").addEventListener("keydown", (event) => {
  const tab = event.target.closest?.('[role="tab"][data-sp-tab]');
  if (!tab) return;
  const next = nextTab(tab.dataset.spTab, event.key);
  if (!next) return;
  event.preventDefault();
  spSelectTab(next);
});

function openTileOptions(key) {
  selectedKey = key;
  const index = state.tiles.findIndex((tile) => tileKey(tile) === key);
  const tile = state.tiles[index];
  if (!tile) return;
  $("tile-options-title").textContent = tile.label;
  $("tile-options-icon").innerHTML = tile.kind === "app" ? renderAppIcon(tile) : tile.kind === "spotify" ? spotifyCover(tile.image, tile.label) : controlIcon(tile.verb);
  $("tile-earlier").disabled = index === 0;
  $("tile-later").disabled = index === state.tiles.length - 1;
  $("tile-options").showModal();
}
function drawApps() {
  const term = $("filter").value.trim().toLowerCase();
  const matches = installedApps.filter((app) => app.name.toLowerCase().includes(term));
  const pinned = new Set(state.tiles.filter((tile) => tile.kind === "app").map((tile) => tile.id));
  $("picker-status").textContent = pluralize(matches.length, "app") + (term ? " found" : " on this computer") + " · " + pinned.size + " pinned";
  $("picker-list").innerHTML = matches.length ? matches.map((app) => '<li><button type="button" data-id="' + escapeHtml(app.id) + '"' + (pinned.has(app.id) ? " disabled" : "") + ' aria-label="' + escapeHtml((pinned.has(app.id) ? "Pinned: " : "Add ") + app.name) + '">' + renderAppIcon(app, true) + '<span class="picker__name">' + escapeHtml(app.name) + '<small>' + (pinned.has(app.id) ? "On your dock" : platformLabel() + " app") + '</small></span><span class="picker__add">' + icon(pinned.has(app.id) ? "check" : "plus") + "</span></button></li>").join("") : '<li class="picker__empty">No apps found. Try a different name.</li>';
}
function drawControls() {
  const groups = availableControls(pickerVerbs(), state.tiles);
  $("control-list").innerHTML = renderControlPicker(groups);
  $("picker-status").textContent = "Pin the controls you reach for most";
}
function selectTab(which) {
  const apps = which === "apps";
  for (const [id, active] of [["tab-apps", apps], ["tab-controls", !apps]]) {
    $(id).classList.toggle("is-active", active);
    $(id).setAttribute("aria-selected", String(active));
    $(id).tabIndex = active ? 0 : -1;
  }
  $("picker-list").hidden = !apps;
  $("control-list").hidden = apps;
  $("picker-search").hidden = !apps;
  if (apps && appsLoaded) drawApps(); else if (!apps) drawControls();
}
async function openPicker() {
  selectTab("apps");
  if (!$("picker").open) $("picker").showModal();
  if (appsLoaded) drawApps();
  else { $("picker-status").textContent = "Loading your apps…"; $("picker-list").innerHTML = '<li class="picker__empty">Finding apps on this computer…</li>'; }
  try {
    const { apps } = await api("/api/apps/installed");
    installedApps = apps; appsLoaded = true;
    if ($("tab-apps").getAttribute("aria-selected") === "true") drawApps();
  } catch (error) { $("picker-status").textContent = "Couldn’t load apps. Close the library and try again."; report(error); }
}
function openSettings() { $("drawer").close(); syncLayout(); if (!$("settings").open) $("settings").showModal(); }
function openDrawer() { if (paired && !$("drawer").open) { arming.disarm("drawer"); $("drawer").showModal(); } }

$("picker-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button || button.disabled || saving) return;
  const app = installedApps.find((item) => item.id === button.dataset.id);
  if (!app) return;
  if (realTiles(state.tiles).length >= MAX_TILES) return notify("Your dock is full. Remove a tile before adding another.", true);
  button.disabled = true;
  try {
    await commitTiles(addAppTile(state.tiles, app));
    drawApps();
    notify(app.name + " added to your dock");
  } catch (error) { report(error); button.disabled = false; }
});
$("control-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-verb]");
  if (!button || button.disabled || saving) return;
  if (realTiles(state.tiles).length >= MAX_TILES) return notify("Your dock is full. Remove a tile before adding another.", true);
  const value = button.dataset.value === undefined ? null : Number(button.dataset.value);
  const item = availableControls(pickerVerbs(), state.tiles).flatMap((group) => group.items).find((item) => item.verb === button.dataset.verb && (item.value ?? null) === value);
  button.disabled = true;
  try { await commitTiles(addControlTile(state.tiles, item.verb, item.label, value)); drawControls(); notify(item.label + " added to your dock"); }
  catch (error) { report(error); button.disabled = false; }
});

// Pointer gestures share stable tile keys. Only the final drop is persisted;
// canceled gestures restore their original order and send no mutation.
let gesture = null, dragGhost = null, edgeTimer = null;
function cleanupGesture(cancel = false) {
  if (!gesture) return;
  clearTimeout(gesture.holdTimer); clearTimeout(edgeTimer); edgeTimer = null;
  if (cancel && gesture.dragging) { state = { ...state, tiles: gesture.previous }; paint(); }
  dragGhost?.remove(); dragGhost = null;
  $("dock").querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  gesture = null;
}
$("dock").addEventListener("contextmenu", (event) => event.preventDefault());
$("dock").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || saving || !event.isPrimary) return;
  // A close button never starts Arrange or a drag, but a swipe from it still pages (9.2).
  const onClose = Boolean(event.target.closest(".tile__close"));
  const tile = onClose ? null : event.target.closest("[data-tile-key]");
  gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, key: tile?.dataset.tileKey, previous: state.tiles, page: currentPage, dragging: false, held: false, wasEditing: editing, onClose };
  if (realTiles(state.tiles).length && !editing && !onClose) gesture.holdTimer = setTimeout(() => {
    if (!gesture) return;
    gesture.held = true; suppressClickUntil = Date.now() + 600;
    enterEditing(); navigator.vibrate?.(18);
  }, 450);
});
$("dock").addEventListener("touchmove", (event) => {
  if (editing && gesture?.key) event.preventDefault();
}, { passive: false });
document.addEventListener("pointermove", (event) => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
  if (!editing) {
    if (Math.hypot(dx, dy) > 10) clearTimeout(gesture.holdTimer);
    return;
  }
  if (!gesture.key || Math.hypot(dx, dy) < 9 && !gesture.dragging) return;
  event.preventDefault();
  if (!gesture.dragging) {
    gesture.dragging = true;
    const original = Array.from($("dock").querySelectorAll("[data-tile-key]")).find((el) => el.dataset.tileKey === gesture.key);
    if (!original) return cleanupGesture(true);
    const bounds = original.getBoundingClientRect();
    dragGhost = original.cloneNode(true);
    dragGhost.classList.add("drag-ghost"); dragGhost.classList.remove("is-editing");
    dragGhost.style.width = bounds.width + "px"; dragGhost.style.height = bounds.height + "px";
    dragGhost.setAttribute("aria-hidden", "true");
    document.body.append(dragGhost);
  }
  dragGhost.style.left = event.clientX + "px"; dragGhost.style.top = event.clientY + "px";
  // An empty slot takes the tile exactly there; an occupied one shifts the slots between.
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-tile-key], [data-empty-slot]");
  if (target?.dataset.emptySlot !== undefined) {
    const next = dropOnSlot(state.tiles, gesture.key, Number(target.dataset.emptySlot));
    if (next !== state.tiles) { state = { ...state, tiles: next }; paint(); }
  } else if (target && target.dataset.tileKey !== gesture.key) {
    state = { ...state, tiles: moveToTile(state.tiles, gesture.key, target.dataset.tileKey) };
    paint();
  }
  $("dock").querySelectorAll("[data-tile-key]").forEach((el) => el.classList.toggle("is-dragging", el.dataset.tileKey === gesture.key));
  const bounds = $("dock").getBoundingClientRect();
  const direction = event.clientX < bounds.left + 40 ? -1 : event.clientX > bounds.right - 40 ? 1 : 0;
  if (!direction) { clearTimeout(edgeTimer); edgeTimer = null; }
  else if (!edgeTimer) edgeTimer = setTimeout(() => {
    edgeTimer = null;
    if (!gesture?.dragging) return;
    const page = Math.max(0, Math.min(pageCount(state.tiles, layout, true) - 1, currentPage + direction));
    if (page === currentPage) return;
    // The tile lands on the near edge of the new page: into the slot itself
    // when it is empty (the extra page's included), shifting when it is not.
    const capacity = layout.columns * layout.rows;
    state = { ...state, tiles: dropOnSlot(state.tiles, gesture.key, page * capacity + (direction < 0 ? capacity - 1 : 0)) };
    currentPage = page; paint();
  }, 550);
}, { passive: false });
document.addEventListener("pointerup", (event) => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const previous = gesture.previous, dragged = gesture.dragging;
  const startPage = gesture.page;
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
  const swipeUp = !dragged && !gesture.held && dy < -55 && Math.abs(dy) > Math.abs(dx) * 1.3;
  const swipeAcross = !dragged && !gesture.held && !editing && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.3;
  if (dragged || gesture.held || Math.hypot(dx, dy) > 15) suppressClickUntil = Date.now() + 500;
  // More than 10 px between down and up on a close button is a swipe, not a tap.
  if (gesture.onClose && Math.hypot(dx, dy) > 10) suppressCloseUntil = Date.now() + 500;
  cleanupGesture();
  if (dragged) commitTiles(state.tiles, previous).catch(report);
  else if (swipeUp) openDrawer();
  else if (swipeAcross) pageTo(startPage + (dx < 0 ? 1 : -1));
});
document.addEventListener("pointercancel", () => cleanupGesture(true));
window.addEventListener("blur", () => cleanupGesture(true));
let footerGesture;
$("gesture-area").addEventListener("pointerdown", (event) => { footerGesture = event.target.closest(".mini") ? null : { x: event.clientX, y: event.clientY }; });
$("gesture-area").addEventListener("pointerup", (event) => {
  if (footerGesture && footerGesture.y - event.clientY > 35 && Math.abs(event.clientX - footerGesture.x) < 70) { suppressClickUntil = Date.now() + 500; openDrawer(); }
  footerGesture = null;
});
$("dock").addEventListener("scroll", () => {
  if (!$("dock").clientWidth) return;
  const page = Math.round($("dock").scrollLeft / $("dock").clientWidth);
  if (page !== currentPage) arming.disarm("page");
  currentPage = page;
  showPageHint();
  $("page-dots").querySelectorAll("[data-page]").forEach((button) => {
    if (Number(button.dataset.page) === currentPage) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}, { passive: true });
$("page-dots").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (button) pageTo(Number(button.dataset.page));
});
window.addEventListener("resize", () => { syncLayout(); requestAnimationFrame(() => pageTo(currentPage, false)); renderSheetIfOpen(); });
document.addEventListener("click", (event) => {
  // A gesture can open a dialog before the browser emits its follow-up click.
  // Suppress that click globally, even when it is retargeted to the new dialog.
  if (Date.now() < suppressClickUntil && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  const close = event.target.closest("[data-close]");
  if (close) closeDialog($(close.dataset.close));
  if (event.target.closest("[data-open-picker]")) openPicker();
  const closeButton = event.target.closest("button.tile__close");
  if (closeButton) {
    if (Date.now() < suppressCloseUntil && event.detail !== 0) return;
    return handleCloseTap(closeButton);
  }
  // The player list is a small popover: any other tap closes it.
  if (sourcesOpen && !event.target.closest("#media-sources, [data-media-sources]")) { sourcesOpen = false; renderSheet(); }
  if (handleMediaClick(event.target)) return;
  const button = event.target.closest("button[data-action]");
  if (button) activate(button).catch(report);
}, true);
// Mini player, Media sheet and permission controls (DOCK-CONTROLS 5.2, 5.3).
function handleMediaClick(target) {
  const el = target.closest("button");
  if (!el || el.disabled) return false;
  const data = el.dataset;
  if ("mediaOpen" in data || "mediaAllow" in data) openMedia();
  else if (data.miniVol) return true; // pressed on pointerdown; keyboard clicks are handled by the host listener
  else if (data.miniMute) toggleMute(data.miniMute);
  else if (data.media) mediaCommand(data.media);
  else if ("mediaDismiss" in data) {
    const permission = pendingPermission(mediaCaps(caps()), media);
    if (permission) miniDismissed.add(miniDismissKey(permission.player));
    renderMedia();
  } else if ("mediaSources" in data) { sourcesOpen = !sourcesOpen; renderSheet(); }
  else if (data.mediaSelect) { sourcesOpen = false; mediaCommand("select", data.mediaSelect); }
  else if (data.mediaLaunch) mediaCommand("open", data.mediaLaunch);
  else if ("mediaShow" in data) {
    const target = showOnTarget();
    if (target) api("/api/apps/focus", { method: "POST", body: JSON.stringify({ pid: target.pid }) }).catch(report);
  } else if (data.mediaControl) api("/api/control", { method: "POST", body: JSON.stringify({ verb: data.mediaControl }) }).catch(report);
  else if ("volumeMute" in data) toggleMute("level"); else if (data.perm) {
    const permission = sheetPermission() || pendingPermission(mediaCaps(caps()), media);
    if (!permission) return true;
    if (data.perm === "ask") askPermission(permission.player);
    else if (data.perm === "later") { permissionUi.later = permission.player; miniDismissed.add(miniDismissKey(permission.player)); resetPermissionUi(); renderMedia(); }
    else if (data.perm === "settings") api("/api/permissions/open-settings", { method: "POST", body: JSON.stringify({ scope: permission.player }) }).catch(report);
  } else if (!handleSpotifyClick(el)) return false;
  return true;
}
function toggleEditing() { if (!saving) { arming.disarm("arrange"); editing = !editing; paint(); } }
$("edit").addEventListener("click", toggleEditing);
$("edit-done").addEventListener("click", toggleEditing);
$("drawer-edit").addEventListener("click", () => { $("drawer").close(); toggleEditing(); });
for (const [id, delta] of [["tile-earlier", -1], ["tile-later", 1], ["tile-remove", 0]]) {
  $(id).addEventListener("click", async () => {
    $("tile-options").close();
    try { await commitTiles(delta ? moveTile(state.tiles, selectedKey, delta) : removeTile(state.tiles, selectedKey)); notify(delta ? "Position updated" : "Removed from your dock"); }
    catch (error) { report(error); }
  });
}
$("add").addEventListener("click", openPicker);
$("picker-close").addEventListener("click", () => $("picker").close());
$("tab-apps").addEventListener("click", () => selectTab("apps"));
$("tab-controls").addEventListener("click", () => selectTab("controls"));
document.querySelector(".picker__tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !feature("controls")) return;
  event.preventDefault();
  const apps = event.key === "Home" || event.key !== "End" && $("tab-apps").getAttribute("aria-selected") !== "true";
  selectTab(apps ? "apps" : "controls"); $(apps ? "tab-apps" : "tab-controls").focus();
});
$("filter").addEventListener("input", drawApps);
$("settings-open").addEventListener("click", openSettings);
$("swipe-settings").addEventListener("click", openDrawer);
function openControls() { $("drawer").close(); $("controls-grid").innerHTML = controlsSheetHtml(); $("controls").showModal(); }
$("controls-open").addEventListener("click", openControls);
document.querySelectorAll("button[data-per-page]").forEach((button) => button.addEventListener("click", () => saveLayout({ perPage: Number(button.dataset.perPage) })));
document.querySelectorAll("button[data-background]").forEach((button) => button.addEventListener("click", () => saveLayout({ background: button.dataset.background })));
$("immersive").addEventListener("change", () => saveLayout({ immersive: $("immersive").checked }));
$("show-labels").addEventListener("change", () => saveLayout({ showLabels: $("show-labels").checked }));
$("close-buttons").addEventListener("change", () => saveLayout({ closeButtons: $("close-buttons").checked }));
$("mini-setting").addEventListener("change", () => saveLayout({ miniPlayer: $("mini-setting").checked }));
$("glass-theme").addEventListener("change", () => saveLayout({ theme: $("glass-theme").value }));
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    if (!document.documentElement.requestFullscreen) return notify("Use your browser’s fullscreen option, then turn your phone sideways.");
    await document.documentElement.requestFullscreen();
    await screen.orientation?.lock?.("landscape").catch(() => {});
    $("settings").close();
    $("drawer").close();
  } catch { notify("Fullscreen isn’t available here. Turn your phone sideways to continue."); }
}
$("fullscreen").addEventListener("click", toggleFullscreen);
$("drawer-fullscreen").addEventListener("click", toggleFullscreen);
$("drawer-open").addEventListener("click", openDrawer);
$("drawer-close").addEventListener("click", () => $("drawer").close());
$("drawer-settings").addEventListener("click", openSettings);
$("drawer-apps").addEventListener("click", () => { $("drawer").close(); openPicker(); });
$("drawer-controls").addEventListener("click", openControls);
$("drawer-media").addEventListener("click", openMedia);
$("power-lock").addEventListener("click", () => runPower("lock", { closeDrawer: true }).catch(report));
$("power-sleep").addEventListener("click", () => runPower("sleep", { closeDrawer: true }).catch(report));
$("power-shutdown").addEventListener("click", () => openShutdown().catch(report));
$("drawer-capture").addEventListener("click", openCapture);
const inputPad = createInputPad({ api, notify, WebSocketClass: WebSocket, storage: localStorage });
$("drawer-input").addEventListener("click", () => inputPad.open());
$("capture-screenshot").addEventListener("click", () => captureAction("screenshot"));
$("capture-record").addEventListener("click", () => captureAction(captureActive() ? "stop" : "start"));
$("recording-stop").addEventListener("click", () => captureAction("stop"));
setInterval(() => { if (paired && !document.hidden && feature("capture")) refreshCapture().catch(() => {}); }, 2000);
setInterval(() => { if (paired && captureActive() && !document.hidden) paintCapture(); }, 500);
// The invisible lower edge is also a keyboard-accessible button. Track swipes
// at document level so lifting above the original hit area still opens it.
let edgeGesture = null;
$("drawer-open").addEventListener("pointerdown", (event) => { edgeGesture = { id: event.pointerId, y: event.clientY }; });
document.addEventListener("pointerup", (event) => {
  if (edgeGesture?.id === event.pointerId && edgeGesture.y - event.clientY > 25) { suppressClickUntil = Date.now() + 500; openDrawer(); }
  edgeGesture = null;
});
document.addEventListener("pointercancel", () => { edgeGesture = null; });
let drawerGesture = null;
$("drawer-close").addEventListener("pointerdown", (event) => { drawerGesture = { id: event.pointerId, y: event.clientY, dialog: "drawer" }; });
$("media-grip").addEventListener("pointerdown", (event) => { drawerGesture = { id: event.pointerId, y: event.clientY, dialog: "media" }; });
$("media-grip").addEventListener("click", () => closeDialog($("media")));
document.addEventListener("pointerup", (event) => {
  if (drawerGesture?.id === event.pointerId && event.clientY - drawerGesture.y > 30) { suppressClickUntil = Date.now() + 500; closeDialog($(drawerGesture.dialog)); }
  drawerGesture = null;
});
// Swipe up on the mini player opens the Media sheet, not the drawer; sideways does nothing (9.3).
let miniGesture = null;
for (const host of [$("mini-player"), $("nowplaying")]) {
  host.addEventListener("pointerdown", (event) => {
    // The seek row, the volume buttons and mute are their own controls: no swipe-up, no tap-to-open.
    const own = event.target.closest("[data-mini-seek-hit], [data-mini-vol], [data-mini-mute]");
    miniGesture = event.target.closest(".mini") && !own ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    if (!own || event.button !== 0) return;
    event.stopPropagation();
    const vol = event.target.closest("[data-mini-vol]");
    if (vol) { if (!vol.disabled) { event.preventDefault(); pressMiniVolume(vol); } return; }
    if (event.target.closest("[data-mini-mute]")) return; // toggles on click
    startMiniSeek(event);
  });
  // Enter / Space (and assistive taps) on a volume button: one step.
  host.addEventListener("click", (event) => {
    const vol = event.target.closest("[data-mini-vol]");
    if (!vol || vol.disabled || event.detail !== 0) return;
    pressMiniVolume(vol).then(() => releaseMiniVolume());
  });
  host.addEventListener("keydown", (event) => {
    const hit = event.target.closest("[data-mini-seek-hit]");
    if (!hit || !media?.durationMs || !online) return;
    const from = mediaPosition(media, mediaReceivedAt, Date.now()) ?? 0;
    const next = seekKey(from, media.durationMs, event.key);
    if (next === null) return;
    event.preventDefault();
    media = { ...media, positionMs: next };
    mediaReceivedAt = Date.now();
    paintMiniSeek(next, true);
    miniSeekThrottle.input(next);
  });
  host.addEventListener("keyup", (event) => {
    if (event.target.closest("[data-mini-seek-hit]") && miniSeekThrottle.pending) miniSeekThrottle.commit(media?.positionMs ?? 0);
  });
}
const miniSeekThrottle = createThrottle((position) => mediaCommand("seek", position), { intervalMs: 100 });
// Seek drag: local only while dragging, one request on release, cancel reverts.
function startMiniSeek(event) {
  const hit = event.target.closest("[data-mini-seek-hit]");
  if (!hit || !media?.durationMs || !online) return;
  event.preventDefault();
  const line = hit.closest("[data-mini-seek]");
  try { hit.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers can't be captured. */ }
  // Positions map onto the line itself; the rest of the row (times, padding) clamps to its ends.
  const bar = line.querySelector(".mini__seek-bar");
  miniSeek = { id: event.pointerId, line, bar, value: seekFromPointer(event.clientX, bar.getBoundingClientRect(), media.durationMs) };
  line.classList.add("is-dragging");
  paintMiniSeek(miniSeek.value, true);
}
function endMiniSeek(commit) {
  if (!miniSeek) return;
  const { line, value } = miniSeek;
  miniSeek = null;
  line.classList.remove("is-dragging");
  suppressClickUntil = Date.now() + 400;
  if (commit && media) {
    media = { ...media, positionMs: value };
    mediaReceivedAt = Date.now();
    paintMiniSeek(value, true);
    mediaCommand("seek", value);
  } else tickMini(true);
  renderMedia();
}
document.addEventListener("pointermove", (event) => {
  if (!miniSeek || event.pointerId !== miniSeek.id || !media?.durationMs) return;
  miniSeek.value = seekFromPointer(event.clientX, miniSeek.bar.getBoundingClientRect(), media.durationMs);
  paintMiniSeek(miniSeek.value, true);
});
document.addEventListener("pointerup", (event) => {
  if (miniSeek && event.pointerId === miniSeek.id) endMiniSeek(true);
  releaseMiniVolume();
});
document.addEventListener("pointercancel", (event) => {
  if (miniSeek && event.pointerId === miniSeek.id) endMiniSeek(false);
  releaseMiniVolume();
});
window.addEventListener("blur", () => { endMiniSeek(false); releaseMiniVolume(); });
document.addEventListener("pointerup", (event) => {
  if (miniGesture?.id !== event.pointerId) return;
  const dx = event.clientX - miniGesture.x, dy = miniGesture.y - event.clientY;
  miniGesture = null;
  if (dy >= 35 && dy > Math.abs(dx)) { suppressClickUntil = Date.now() + 500; openMedia(); }
  else if (Math.abs(dx) > 15) suppressClickUntil = Date.now() + 400;
});
document.addEventListener("pointercancel", () => { miniGesture = null; });
// Any other tap disarms an armed close button or Sleep tile (5.1).
document.addEventListener("pointerdown", (event) => {
  const key = arming.key;
  if (!key) return;
  // An app is armed by its close button; tapping the tile itself focuses the app and disarms.
  const own = event.target.closest?.("[data-close-for], [data-tile-key]");
  const ownKey = own?.dataset.closeFor ?? (key.startsWith("control:") ? own?.dataset.tileKey : undefined);
  if (ownKey !== key) arming.disarm("tap");
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && arming.key && !document.querySelector("dialog[open]")) arming.disarm("escape");
});
// Seek and volume: the thumb follows the finger; the host gets throttled updates.
$("media-content").addEventListener("input", (event) => {
  const input = event.target.closest("[data-seek]");
  if (!input || !media?.durationMs) return;
  seeking = true;
  const track = input.closest("[data-progress]");
  track.classList.add("is-instant");
  track.style.setProperty("--p", (Number(input.value) / media.durationMs).toFixed(4));
  $("media-content").querySelector("[data-progress-time]").textContent = formatTime(Number(input.value));
});
$("media-content").addEventListener("change", (event) => {
  const input = event.target.closest("[data-seek]");
  if (!input || !media) return;
  seeking = false;
  const position = Number(input.value);
  media = { ...media, positionMs: position };
  mediaReceivedAt = Date.now();
  mediaCommand("seek", position);
});
$("media-volume").addEventListener("pointerdown", (event) => { if (event.target.closest("[data-volume-input]")) volume.dragging = true; });
$("media-volume").addEventListener("input", (event) => {
  const input = event.target.closest("[data-volume-input]");
  if (!input) return;
  volume.dragging = true;
  volume.level = clampLevel(input.value);
  paintVolume(false);
  volumeThrottle.input(volume.level);
});
$("media-volume").addEventListener("change", (event) => {
  const input = event.target.closest("[data-volume-input]");
  if (!input) return;
  volume.dragging = false;
  volume.level = clampLevel(input.value);
  paintVolume(false);
  volumeThrottle.commit(volume.level);
});
document.addEventListener("pointerup", () => { if (volume.dragging) setTimeout(() => { volume.dragging = false; }, 0); });
$("media").addEventListener("close", () => { sourcesOpen = false; seeking = false; volume.dragging = false; spCancelPress(); sp.queueOpen = false; spQueueLoader.poll(false); });
// Back steps out of the queue panel before it closes the sheet. Android Back
// calls close() on the top open <dialog>; Escape fires keydown, then cancel.
// The ×, the grip, a swipe down and a tap outside close the sheet outright
// (closeDialog).
let spBackSwallow = false;
$("media").close = function close(value) {
  if (mediaBackStep({ queueOpen: sp.queueOpen && this.open }) === "queue") return spCloseQueue();
  return closeDialog(this, value);
};
$("media").addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || mediaBackStep({ queueOpen: sp.queueOpen }) !== "queue" || document.querySelector("dialog[open]:not(#media)")) return;
  event.preventDefault();
  spBackSwallow = true;
  setTimeout(() => { spBackSwallow = false; }, 0);
  spCloseQueue();
}, true);
$("media").addEventListener("cancel", (event) => {
  if (!spBackSwallow && mediaBackStep({ queueOpen: sp.queueOpen }) !== "queue") return;
  event.preventDefault();
  if (!spBackSwallow) spCloseQueue();
});
setInterval(() => { if ($("media").open && !document.hidden) tickProgress(); }, 1000);
setInterval(() => { if (!document.hidden) tickMini(); }, 1000);
$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  try { appsLoaded = false; await refresh(); connect(); notify("Your dock is up to date"); } catch (error) { report(error); }
  finally { $("refresh").disabled = false; }
});
$("confirm-cancel").addEventListener("click", () => $("confirm").close("no"));
$("confirm-go").addEventListener("click", () => $("confirm").close($("confirm").dataset.primary || "shutdown"));
$("confirm-restart").addEventListener("click", () => $("confirm").close("restart"));
$("confirm-settings").addEventListener("click", () => {
  $("confirm").close("no");
  api("/api/permissions/open-settings", { method: "POST", body: JSON.stringify({ scope: "system-events" }) }).catch(report);
});
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
  });
}
/** A neutral name the computer lists this device under (npm run devices). */
function deviceName(ua = navigator.userAgent) {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android phone";
  return "Browser";
}
$("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/auth", { method: "POST", body: JSON.stringify({ pin: $("pin").value, deviceName: deviceName() }) });
    showApp(); await refresh(); connect(); announceReady();
  } catch (error) { showPair(error.message); } finally { button.disabled = false; }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* The shell also works without a service worker. */ });
}
syncLayout();
(async function boot() {
  try { await refresh(); showApp(); connect(); announceReady(); }
  catch (error) { showPair(error.message === "unauthorized" ? "" : "Start WinDock on your computer, then connect with its PIN.", error.message === "unauthorized"); }
})();
// Natives may inject WinDockNative after this module ran, then say so.
window.addEventListener("windock-native-ready", () => {
  syncNative();
  applyFeatures();
  syncPill();
  announceReady();
});
// Refresh when returning to the dock. No background native polling while hidden.
document.addEventListener("visibilitychange", () => { if (!document.hidden && paired) refresh().then(connect).catch(report); });
