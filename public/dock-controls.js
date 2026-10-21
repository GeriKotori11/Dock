/**
 * Dock controls: the pure rules behind close, media, volume and power
 * (docs/design/DOCK-CONTROLS.md sections 6, 7, 9 and 13).
 *
 * No DOM and no browser globals: the PWA gates run every rule, state machine
 * and copy string here under Node. app.js wires them to the page.
 */

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");

/** "{Mac/PC}" in the copy deck. */
export function computerKind(platform) {
  return platform === "macos" ? "Mac" : "PC";
}

// ---- capability map (section 7), new keys missing = not offered ----

const POWER_STATUSES = new Set(["ready", "needs-permission", "denied"]);
const PERMISSIONS = new Set(["granted", "needed", "denied", "not-required"]);

/**
 * What each power action is on this host: a status string, or null when not
 * offered. New hosts send `features.power`; older hosts fall back to `verbs`
 * plus `allowDestructive`, which on those hosts also gates lock (7.3).
 */
export function powerCaps({ features, verbs, allowDestructive } = {}) {
  const allowed = allowDestructive !== false;
  const power = features?.power;
  if (isObject(power)) {
    const status = (key) => (POWER_STATUSES.has(power[key]) ? power[key] : null);
    return {
      legacy: false,
      lock: status("lock"),
      sleep: allowed ? status("sleep") : null,
      restart: allowed ? status("restart") : null,
      shutdown: allowed ? status("shutdown") : null,
    };
  }
  const verbList = list(verbs);
  const legacy = (verb) => (allowed && verbList.includes(verb) ? "ready" : null);
  return { legacy: true, lock: legacy("lock"), sleep: legacy("sleep"), restart: legacy("restart"), shutdown: legacy("shutdown") };
}

/** True when a power verb is offered (any known status). */
export function offersPower(caps, verb) {
  return Boolean(caps && caps[verb]);
}

/** The Shut down entry: hidden, or which of shut down / restart it offers. */
export function shutdownEntry(caps) {
  const shutdown = offersPower(caps, "shutdown"), restart = offersPower(caps, "restart");
  if (!shutdown && !restart) return null;
  return { shutdown, restart, label: shutdown ? "Shut down" : "Restart" };
}

/** "slider" (new host), "buttons" (legacy volume verbs) or null. */
export function volumeMode({ features, verbs } = {}) {
  const volume = features?.volume;
  if (isObject(volume) && volume.get === true && volume.set === true) return "slider";
  const verbList = list(verbs);
  if (["volume-down", "mute-toggle", "volume-up"].some((verb) => verbList.includes(verb))) return "buttons";
  return null;
}

function normalizePlayer(raw) {
  if (!isObject(raw) || !text(raw.id) || !text(raw.name)) return null;
  return {
    id: text(raw.id),
    name: text(raw.name),
    appId: text(raw.appId) || null,
    installed: raw.installed === true,
    running: raw.running === true,
    permission: PERMISSIONS.has(raw.permission) ? raw.permission : "not-required",
  };
}

/**
 * The media capability. `features.media` on new hosts; otherwise the legacy
 * `nowPlaying` boolean (missing = on) read through /api/nowplaying, with
 * transport through the `media-*` verbs the host lists.
 */
export function mediaCaps({ features, verbs } = {}) {
  const media = features?.media;
  const verbList = list(verbs);
  if (isObject(media)) {
    return {
      available: true,
      legacy: false,
      sources: media.sources === "apps" ? "apps" : "system",
      players: list(media.players).map(normalizePlayer).filter(Boolean),
      artwork: media.artwork === true,
      sessions: media.sessions === true,
    };
  }
  return {
    available: features?.nowPlaying !== false,
    legacy: true,
    sources: "system",
    players: [],
    artwork: false,
    sessions: false,
    transport: {
      previous: verbList.includes("media-previous"),
      playPause: verbList.includes("media-play-pause"),
      next: verbList.includes("media-next"),
    },
  };
}

/** The drawer's Media button: media capability or volume capability (6.2). */
export function showMediaButton(ctx) {
  return mediaCaps(ctx).available || volumeMode(ctx) !== null;
}

/** Fullscreen in the drawer: not inside a native shell, and only where the API exists (6.5). */
export function showFullscreenButton({ native, fullscreenEnabled }) {
  return !native && fullscreenEnabled === true;
}

/**
 * Whether a tile gets the close button, and for how many instances (6.1).
 * `running` is the snapshot's list; every instance must be closable.
 */
export function closeTarget(tile, { features, running, editing = false, offline = false, enabled = true } = {}) {
  if (features?.close !== true || tile?.kind !== "app" || tile.available === false) return null;
  if (editing || offline || enabled === false) return null;
  const instances = list(running).filter((entry) => isObject(entry) && entry.id === tile.id);
  if (!instances.length || !instances.every((entry) => entry.closable === true)) return null;
  return { count: instances.length };
}

// ---- close arming (9.2) ----

export const ARM_WINDOW_MS = 3000;
export const ARM_MIN_GAP_MS = 350;

/**
 * One armed target at a time. `tap(key)` returns "armed" (first tap),
 * "ignored" (second tap inside the 350 ms double-tap guard) or "confirm".
 * Arming another key disarms the first; the window closes after 3 s.
 */
export function createArming({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, windowMs = ARM_WINDOW_MS, minGapMs = ARM_MIN_GAP_MS, onChange = () => {} } = {}) {
  let armed = null;
  function clear() { if (armed) clearTimer(armed.timer); armed = null; }
  return {
    get key() { return armed ? armed.key : null; },
    isArmed(key) { return Boolean(armed) && armed.key === key; },
    tap(key) {
      if (armed && armed.key === key) {
        if (now() - armed.at < minGapMs) return "ignored";
        clear();
        onChange(null, "confirm", key);
        return "confirm";
      }
      if (armed) { const previous = armed.key; clear(); onChange(null, "replaced", previous); }
      const timer = setTimer(() => {
        if (!armed || armed.key !== key) return;
        armed = null;
        onChange(null, "timeout", key);
      }, windowMs);
      armed = { key, at: now(), timer };
      onChange(key, "armed", key);
      return "armed";
    },
    disarm(reason = "cancel") {
      if (!armed) return false;
      const key = armed.key;
      clear();
      onChange(null, reason, key);
      return true;
    },
  };
}

// ---- volume throttle (8.4) ----

/**
 * At most one `send(value, false)` per interval while dragging, with the
 * latest value sent at the end of each interval; `commit(value)` always sends
 * the final value (`send(value, true)`) and drops anything pending.
 */
export function createThrottle(send, { intervalMs = 100, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let lastAt = -Infinity, timer = null, pending;
  function flush() {
    timer = null;
    lastAt = now();
    send(pending, false);
  }
  return {
    input(value) {
      pending = value;
      if (timer) return;
      const wait = intervalMs - (now() - lastAt);
      if (wait <= 0) { lastAt = now(); send(value, false); }
      else timer = setTimer(flush, wait);
    },
    commit(value) {
      if (timer) { clearTimer(timer); timer = null; }
      lastAt = now();
      send(value, true);
    },
    cancel() { if (timer) { clearTimer(timer); timer = null; } },
    get pending() { return timer !== null; },
  };
}

// ---- status pill (5.7) and expected disconnects (5.6) ----

export const EXPECTED_WINDOW_MS = 60_000;
export const RESTART_GRACE_MS = 5 * 60_000;
const REASONS = new Set(["asleep", "off", "restarting"]);

/** The memory stored after our own sleep / shut down / restart command. */
export function expectDisconnect(verb, computer, at) {
  const reason = { sleep: "asleep", shutdown: "off", restart: "restarting" }[verb];
  return reason ? { reason, computer: String(computer || ""), at } : null;
}

/** Parse stored memory; anything malformed reads as none. */
export function readExpected(raw) {
  let value = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { return null; } }
  if (!isObject(value) || !REASONS.has(value.reason) || !Number.isFinite(value.at)) return null;
  return { reason: value.reason, computer: typeof value.computer === "string" ? value.computer : "", at: value.at };
}

/**
 * Which pill to show: null, "reconnecting", "restarting", "asleep", "off" or
 * "locked". A socket close within 60 s of our own command uses that command's
 * reason; "restarting" falls back to "reconnecting" after 5 minutes.
 */
export function pillVariant({ paired = true, online, offlineVisible, locked, expected, computer, disconnectedAt, now }) {
  if (!paired) return null;
  if (online) return locked === true ? "locked" : null;
  if (!offlineVisible) return null;
  const memory = readExpected(expected);
  const matches = memory && (!memory.computer || !computer || memory.computer === computer)
    && Number.isFinite(disconnectedAt) && disconnectedAt >= memory.at && disconnectedAt - memory.at <= EXPECTED_WINDOW_MS;
  if (!matches) return "reconnecting";
  if (memory.reason === "restarting" && now - memory.at > RESTART_GRACE_MS) return "reconnecting";
  return memory.reason;
}

/** Pill copy and presentation per variant (13, 14). */
export function pillContent(variant, computer) {
  const name = computer || "your computer";
  switch (variant) {
    case "reconnecting": return { text: `Reconnecting to ${name}…`, icon: null, pulse: true, dim: true };
    case "restarting": return { text: `${name} is restarting…`, icon: null, pulse: true, dim: true };
    case "asleep": return { text: `${name} is asleep · Wake it to reconnect`, icon: "moon", pulse: false, dim: true };
    case "off": return { text: `${name} is off · Turn it on to reconnect`, icon: "power", pulse: false, dim: true };
    case "locked": return { text: `${name} is locked`, icon: "lock", pulse: false, dim: false };
    default: return null;
  }
}

// ---- close outcomes (5.1) ----

/**
 * Toast copy for a close response. `status` is the HTTP status (0 for a
 * network failure or the client's own 8 s timeout); `gone` says whether the
 * app should leave the running list.
 */
export function closeOutcome({ status, body, app, computer }) {
  const name = app || "The app";
  const host = computer || "your computer";
  if (status === 404) return { message: `${name} was already closed.`, tone: "success", gone: true };
  if (status !== 200 || !isObject(body)) {
    return { message: `${host} couldn't close ${name}. Try again, or close it on the computer.`, tone: "error", gone: false };
  }
  const stillOpen = list(body.stillOpen);
  const requested = Number.isInteger(body.requested) && body.requested > 0 ? body.requested : Math.max(1, stillOpen.length);
  const closed = Number.isInteger(body.closed) ? Math.max(0, Math.min(requested, body.closed)) : requested - stillOpen.length;
  if (!stillOpen.length && closed >= requested) {
    return { message: requested > 1 ? `Closed ${requested} ${name} windows` : `${name} closed`, tone: "success", gone: true };
  }
  if (closed <= 0) {
    return { message: `${name} is still open. It may be asking to save changes on ${host}.`, tone: "neutral", gone: false };
  }
  return { message: `Closed ${closed} of ${requested} ${name} windows. One may be asking to save changes on ${host}.`, tone: "neutral", gone: false };
}

/** Accessible names for the close button (11, 13). */
export function closeLabels(app, count = 1) {
  const multi = count > 1;
  return {
    rest: multi ? `Close all ${count} ${app} windows` : `Close ${app}`,
    armed: `Confirm: close ${app}`,
    pill: multi ? "Close all" : "Close",
    live: `Tap again to close ${app}.`,
  };
}

// ---- mini player visibility (6.2) ----

/**
 * The permission a running macOS player still needs, from /api/media's
 * `permission` or from `features.media.players`. Null when none.
 */
export function pendingPermission(caps, media) {
  const live = media?.permission;
  if (isObject(live) && ["needed", "denied"].includes(live.status) && text(live.player)) {
    const player = caps?.players?.find((entry) => entry.id === live.player);
    return { player: text(live.player), name: player?.name || text(live.name) || text(live.player), appId: player?.appId || null, status: live.status };
  }
  const waiting = caps?.players?.find((entry) => entry.running && ["needed", "denied"].includes(entry.permission));
  return waiting ? { player: waiting.id, name: waiting.name, appId: waiting.appId, status: waiting.permission } : null;
}

/** "hidden", "player" or "permission". */
export function miniPlayerMode({ caps, media, enabled = true, offlineVisible = false, dismissed = false }) {
  if (!caps?.available || enabled === false || offlineVisible) return "hidden";
  if (media?.active) return "player";
  const permission = pendingPermission(caps, media);
  if (permission && permission.status === "needed" && !dismissed) return "permission";
  return "hidden";
}

// ---- power dialog (5.6) ----

/** Title, body and buttons of the Shut down dialog for what the host offers. */
export function shutdownDialog(entry, computer) {
  const name = computer || "your computer";
  if (!entry) return null;
  if (!entry.shutdown) {
    return { title: `Restart ${name}?`, body: "Apps with unsaved work may ask on the computer first. WinDock reconnects when it's back.", primary: "restart", restart: false };
  }
  return { title: `Shut down ${name}?`, body: `Apps with unsaved work may ask on the computer before it turns off. To reconnect, you'll need to turn ${name} on.`, primary: "shutdown", restart: entry.restart };
}

/** Toast after a power command succeeds. */
export function powerToast(verb, computer) {
  const name = computer || "Your computer";
  return {
    lock: `${name} locked`,
    sleep: `${name} is going to sleep`,
    shutdown: `Shutting down ${name}`,
    restart: `Restarting ${name}`,
  }[verb] || "Command sent";
}

/** Accessible names for the drawer's power buttons (13). */
export function powerLabels(computer, entry) {
  const name = computer || "your computer";
  return {
    lock: `Lock ${name}`,
    sleep: `Put ${name} to sleep`,
    shutdown: entry && !entry.restart ? `Shut down ${name}` : entry && !entry.shutdown ? `Restart ${name}` : `Shut down or restart ${name}`,
  };
}

// ---- mini player volume and seek (5.2 additions) ----

export const VOLUME_STEP = 5;
export const HOLD_DELAY_MS = 400;
export const HOLD_REPEAT_MS = 150;
export const CHIP_HIDE_MS = 1200;
export const SEEK_KEY_STEP_MS = 5000;
export const MINI_VOLUME_MIN_WIDTH = 440;
/** With the mute button the group is 44 px wider, so it needs 44 px more room. */
export const MINI_VOLUME_MUTE_MIN_WIDTH = MINI_VOLUME_MIN_WIDTH + 44;

/** A volume level one step up (+1) or down (-1), clamped to 0–100. */
export function stepVolume(level, direction, step = VOLUME_STEP) {
  const base = Number(level);
  if (level === null || level === undefined || !Number.isFinite(base)) return null;
  return Math.max(0, Math.min(100, Math.round(base + Math.sign(direction) * step)));
}

/**
 * Volume buttons in the mini player: "level" (POST /api/volume with a level)
 * when the host can set the volume, "legacy" (volume-up/down verbs through
 * /api/control) on older hosts without `features.volume`, or null.
 */
export function miniVolumeMode({ features, verbs } = {}) {
  const volume = features?.volume;
  if (isObject(volume)) return volume.set === true ? "level" : null;
  const verbList = list(verbs);
  return verbList.includes("volume-up") || verbList.includes("volume-down") ? "legacy" : null;
}

/**
 * The mini player's mute button: "level" (POST /api/volume { muted }) when the
 * host reports `features.volume.mute`, "legacy" (the mute-toggle verb, no state)
 * on older hosts without `features.volume`, or null.
 */
export function miniMuteMode({ features, verbs } = {}) {
  const volume = features?.volume;
  if (isObject(volume)) return volume.set === true && volume.mute === true ? "level" : null;
  return list(verbs).includes("mute-toggle") ? "legacy" : null;
}

/** The floating mini player's width: min(440px, 48vw, 100% - 48px), or min(560px, 62vw, 100% - 48px) with volume. */
export function miniPlayerWidth({ viewportWidth, containerWidth, wide = false }) {
  return Math.min(wide ? 560 : 440, (wide ? 0.62 : 0.48) * viewportWidth, containerWidth - 48);
}

/**
 * Volume buttons show only on the floating player, and only when the wide width
 * is at least 440 px (484 px when the group also has the mute button). Below
 * that the whole group hides; the Media sheet keeps the volume row.
 */
export function miniVolumeShown({ mode, mute = null, immersive = true, viewportWidth, containerWidth }) {
  if (!mode || !immersive) return false;
  const min = mute ? MINI_VOLUME_MUTE_MIN_WIDTH : MINI_VOLUME_MIN_WIDTH;
  return miniPlayerWidth({ viewportWidth, containerWidth: containerWidth ?? viewportWidth, wide: true }) >= min;
}

/** The level chip: "45%", "Muted", or "" when the level is unknown. */
export function miniVolumeChip({ level, muted } = {}) {
  if (muted === true) return "Muted";
  return Number.isFinite(level) ? `${level}%` : "";
}

/**
 * Press-and-hold: `fire()` once at `start()`, then after `delayMs` every
 * `intervalMs` until `stop()`.
 */
export function createHoldRepeat(fire, { delayMs = HOLD_DELAY_MS, intervalMs = HOLD_REPEAT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, active = false;
  function schedule(ms) {
    timer = setTimer(() => {
      timer = null;
      if (!active) return;
      fire();
      if (active) schedule(intervalMs);
    }, ms);
  }
  function stop() {
    active = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  return {
    start() { stop(); active = true; fire(); if (active) schedule(delayMs); },
    stop,
    get active() { return active; },
  };
}

/**
 * The mini player's volume buttons: each step moves the level by 5 from the
 * last known level, holding repeats, and requests go through the same
 * throttle as the sheet's slider (at most one per 100 ms, plus the final
 * value on release when one is still waiting). `send(level, final)`.
 */
export function createVolumeStepper({ send, getLevel, onLevel = () => {}, step = VOLUME_STEP, delayMs = HOLD_DELAY_MS, intervalMs = HOLD_REPEAT_MS, throttleMs = 100, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let direction = 0, level = null;
  const throttle = createThrottle(send, { intervalMs: throttleMs, now, setTimer, clearTimer });
  const repeat = createHoldRepeat(() => {
    const next = stepVolume(level, direction, step);
    if (next === null) return repeat.stop();
    if (next === level) return;
    level = next;
    onLevel(level);
    throttle.input(level);
  }, { delayMs, intervalMs, setTimer, clearTimer });
  function release() {
    if (!repeat.active && !throttle.pending) return;
    repeat.stop();
    if (throttle.pending) throttle.commit(level);
  }
  return {
    press(dir) {
      release();
      direction = Math.sign(dir);
      level = getLevel();
      repeat.start();
    },
    release,
    get holding() { return repeat.active; },
    get level() { return level; },
  };
}

/** "seek" (draggable), "progress" (read-only line) or null (no line) for the mini player. */
export function miniSeekMode(media) {
  if (!media?.active || !(media.durationMs > 0)) return null;
  return media.controls?.seek === true ? "seek" : "progress";
}

const clampMs = (ms, durationMs) => Math.max(0, Math.min(durationMs, Math.round(Number(ms) || 0)));

/** Slider values for the seek hit area, in whole seconds, with a spoken value. */
export function seekAria(positionMs, durationMs, spoken) {
  const position = clampMs(positionMs, durationMs);
  return {
    min: 0,
    max: Math.round(durationMs / 1000),
    now: Math.round(position / 1000),
    text: `${spoken(position)} of ${spoken(durationMs)}`,
  };
}

/** The position under a pointer on the seek line. */
export function seekFromPointer(clientX, rect, durationMs) {
  if (!rect || !(rect.width > 0)) return 0;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return Math.round(ratio * durationMs);
}

/** Arrow keys move ±5 s; other keys return null. */
export function seekKey(positionMs, durationMs, key) {
  const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[key];
  if (!delta) return null;
  return clampMs(positionMs + delta * SEEK_KEY_STEP_MS, durationMs);
}
