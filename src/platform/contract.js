/**
 * The platform provider contract.
 *
 * Every OS-specific capability WinDock needs is declared here once, so the
 * server never reaches for an OS primitive directly. A provider is a plain
 * object implementing every method below; `verify-contract.mjs` proves that
 * each shipped provider does, with the declared arity.
 *
 * Providers receive an injected `exec(file, args)` rather than calling
 * child_process themselves. That is what makes launch/focus/control argv
 * assertable in tests, and it is why no provider ever builds a shell string.
 */

/** Control verbs the UI may request. A provider maps each to a native action. */
export const CONTROL_VERBS = Object.freeze([
  "volume-up",
  "volume-down",
  "volume-set",
  "mute-toggle",
  "media-play-pause",
  "media-next",
  "media-previous",
  "media-stop",
  "brightness-set",
  "lock",
  "sleep",
  "shutdown",
  "restart",
]);

/** Verbs that carry a numeric argument, with their inclusive accepted range. */
export const CONTROL_VERB_RANGES = Object.freeze({
  "volume-set": Object.freeze({ min: 0, max: 100 }),
  "brightness-set": Object.freeze({ min: 0, max: 100 }),
});

/**
 * Verbs that end the user's session or power state, gated separately in the
 * API (`allowDestructive`). Lock is not one of them: it ends nothing, and the
 * dock shows it even when power actions are disabled (DOCK-CONTROLS 8.6).
 */
export const DESTRUCTIVE_VERBS = Object.freeze([
  "sleep",
  "shutdown",
  "restart",
]);

/** Power verbs, in the order the capability map lists them. */
export const POWER_VERBS = Object.freeze(["lock", "sleep", "restart", "shutdown"]);

/**
 * Power verbs the host acknowledges first and runs after a short delay, so the
 * phone gets its reply before the computer goes away.
 */
export const DEFERRED_POWER_VERBS = Object.freeze(["sleep", "restart", "shutdown"]);

/**
 * Required provider methods and their declared arity.
 * Arity is part of the contract: a provider that silently ignores an argument
 * is a defect the contract gate should catch.
 */
export const PROVIDER_METHODS = Object.freeze({
  listInstalledApps: 0,
  listRunningApps: 0,
  launchApp: 1,
  focusApp: 1,
  closeApp: 1,
  control: 2,
  nowPlaying: 0,
  systemStats: 0,
});

/** Required non-function provider properties. */
export const PROVIDER_FIELDS = Object.freeze(["id", "displayName"]);

export function isControlVerb(verb) {
  return CONTROL_VERBS.includes(verb);
}

/**
 * True when the verb requires a numeric argument.
 * A tile for such a verb must store its value, otherwise tapping it would send
 * a valueless request that `validateControl` correctly rejects.
 */
export function verbTakesValue(verb) {
  return Object.prototype.hasOwnProperty.call(CONTROL_VERB_RANGES, verb);
}

export function isDestructiveVerb(verb) {
  return DESTRUCTIVE_VERBS.includes(verb);
}

/**
 * Validate a control request before any provider touches it.
 * Returns `{ ok: true, verb, value }` or `{ ok: false, error }`.
 * Verbs are matched against a fixed allowlist, so an attacker-supplied verb can
 * never become part of a command line.
 */
export function validateControl(verb, value) {
  if (typeof verb !== "string" || !isControlVerb(verb)) {
    return { ok: false, error: "unknown control verb" };
  }
  const range = CONTROL_VERB_RANGES[verb];
  if (!range) {
    if (value !== undefined && value !== null) {
      return { ok: false, error: `${verb} takes no value` };
    }
    return { ok: true, verb, value: null };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: `${verb} requires a numeric value` };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, error: `${verb} requires an integer value` };
  }
  if (value < range.min || value > range.max) {
    return { ok: false, error: `${verb} accepts ${range.min}..${range.max}` };
  }
  return { ok: true, verb, value };
}

/**
 * Structural check used by the contract gate and by provider selection.
 * Returns a list of human-readable problems; empty means conformant.
 */
export function contractViolations(provider) {
  const problems = [];
  if (!provider || typeof provider !== "object") {
    return ["provider is not an object"];
  }
  for (const field of PROVIDER_FIELDS) {
    if (typeof provider[field] !== "string" || provider[field].length === 0) {
      problems.push(`missing string field: ${field}`);
    }
  }
  for (const [method, arity] of Object.entries(PROVIDER_METHODS)) {
    const fn = provider[method];
    if (typeof fn !== "function") {
      problems.push(`missing method: ${method}`);
      continue;
    }
    if (fn.length !== arity) {
      problems.push(`${method} arity ${fn.length}, expected ${arity}`);
    }
  }
  return problems;
}


// ---------------------------------------------------------------------------
// Dock controls (docs/design/DOCK-CONTROLS.md sections 7 and 8)
//
// Everything below is OPTIONAL for a provider. A provider that implements none
// of it keeps working exactly as before: the capability map then carries only
// the four legacy booleans, and the new routes answer 501.
//
// Optional provider fields and methods:
//
//   features.close: true                  the host can close running apps
//                                          (closeApp per pid, polite only).
//   features.media: { sources: "system" | "apps", artwork: bool, sessions: bool }
//   features.volume: { get: bool, set: bool, mute: bool }
//   features.power: { lock?, sleep?, restart?, shutdown? }  static statuses
//                                          ("ready" | "needs-permission" | "denied");
//                                          a missing verb is not offered.
//   features.spotify: { local: { nowPlaying, transport, artwork, seek, shuffle, repeat } }
//   controlVerbs: string[]                 the CONTROL_VERBS this provider maps
//                                          (default: all of them).
//
//   featureState({ installed, running }) -> Promise<{ players?, power?, spotify? }>
//       The live part of the capability map. `installed` is the last catalog
//       scan (or null before the first one), `running` the current running
//       list. Must never launch an app or show a prompt.
//         players: [{ id, name, appId, installed, running, permission }]
//         power:   { restart: "needs-permission", ... } overrides the static ones
//         spotify: { installed: bool }
//   sessionState() -> Promise<{ locked: bool } | null>   cheap, polled
//   media() -> Promise<MediaState | null>
//       The section 8.3 shape (normalized by `normalizeMediaState`). Artwork is
//       a path from `mediaArtworkPath(key)`. Must never launch a player.
//   mediaCommand(action, value, sessionId) -> Promise<void>
//       One of MEDIA_ACTIONS except "open" (the host launches players itself).
//       Throws `hostError(409, { error: "permission needed", player, status })`
//       when the computer has not allowed the player, 404 when nothing plays,
//       501 when the current source cannot do the action.
//   mediaArtwork(key) -> Promise<{ mime, bytes } | null>   at most 512 px
//   volume() -> Promise<{ level: 0..100 | null, muted: bool | null }>
//   setVolume({ level?, muted? }) -> Promise<{ level, muted }>
//   powerStatus(verb) -> Promise<"ready" | "needs-permission" | "denied">
//       Checked before a deferred power verb is acknowledged. May launch a
//       faceless helper (System Events) but never prompts.
//   requestPermission(scope) -> Promise<"granted" | "needed" | "denied" | "not-running">
//       Shows the computer's own consent prompt; resolves when it is answered
//       or after PERMISSION_WAIT_MS ("needed").
//   openPermissionSettings(scope) -> Promise<void>
// ---------------------------------------------------------------------------

export const MEDIA_SOURCES = Object.freeze(["system", "apps"]);
export const MEDIA_ACTIONS = Object.freeze([
  "play", "pause", "toggle", "next", "previous", "seek", "shuffle", "repeat", "select", "open",
]);
export const REPEAT_MODES = Object.freeze(["off", "all", "one"]);
export const PERMISSION_VALUES = Object.freeze(["granted", "needed", "denied", "not-required"]);
export const POWER_STATUSES = Object.freeze(["ready", "needs-permission", "denied"]);
/** Scopes a phone may ask the computer to grant (macOS Automation targets). */
export const PERMISSION_SCOPES = Object.freeze(["spotify", "music", "system-events"]);
/** How long a permission request waits for the person at the computer. */
export const PERMISSION_WAIT_MS = 60_000;
/** Longest seek target accepted, in ms (24 h). */
export const MEDIA_SEEK_MAX_MS = 24 * 60 * 60 * 1000;

const ARTWORK_KEY = /^[a-f0-9]{32}$/;
/** Artwork keys are 32 lowercase hex characters, minted by the provider. */
export function validArtworkKey(key) {
  return typeof key === "string" && ARTWORK_KEY.test(key);
}
/** The path a phone loads artwork from (never an internet URL). */
export function mediaArtworkPath(key) {
  if (!validArtworkKey(key)) throw new Error("invalid artwork key");
  return `/api/media/artwork?key=${key}`;
}

/** An Error carrying an HTTP status and the exact JSON body to send. */
export function hostError(status, body) {
  const error = new Error(body?.error || "error");
  error.status = status;
  error.body = body;
  return error;
}

/**
 * Validate a POST /api/media body. Returns `{ ok: true, action, value,
 * sessionId }` or `{ ok: false, error }`.
 */
export function validateMediaCommand(body) {
  const action = body?.action;
  if (typeof action !== "string" || !MEDIA_ACTIONS.includes(action)) return { ok: false, error: "unknown media action" };
  let sessionId = body.sessionId ?? null;
  if (sessionId !== null && (typeof sessionId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(sessionId))) {
    return { ok: false, error: "sessionId must be a short string" };
  }
  let value = body.value ?? null;
  switch (action) {
    case "seek":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MEDIA_SEEK_MAX_MS) {
        return { ok: false, error: "seek takes an integer position in ms" };
      }
      break;
    case "shuffle":
      if (typeof value !== "boolean") return { ok: false, error: "shuffle takes true or false" };
      break;
    case "repeat":
      if (!REPEAT_MODES.includes(value)) return { ok: false, error: "repeat takes off, all or one" };
      break;
    case "select":
      value = value ?? sessionId;
      if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value)) return { ok: false, error: "select takes a sessionId" };
      sessionId = value;
      break;
    case "open":
      if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) return { ok: false, error: "open takes a player id" };
      break;
    default:
      if (value !== null) return { ok: false, error: `${action} takes no value` };
  }
  return { ok: true, action, value, sessionId };
}

/** Validate a POST /api/volume body: `{ level?: 0..100 integer, muted?: bool }`, at least one. */
export function validateVolume(body) {
  const out = {};
  if (body?.level !== undefined) {
    if (typeof body.level !== "number" || !Number.isInteger(body.level) || body.level < 0 || body.level > 100) {
      return { ok: false, error: "level must be an integer 0..100" };
    }
    out.level = body.level;
  }
  if (body?.muted !== undefined) {
    if (typeof body.muted !== "boolean") return { ok: false, error: "muted must be true or false" };
    out.muted = body.muted;
  }
  if (!Object.keys(out).length) return { ok: false, error: "send level or muted" };
  return { ok: true, ...out };
}

const str = (v, max = 512) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const msOrNull = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const MEDIA_CONTROLS = ["previous", "next", "playPause", "seek", "shuffle", "repeat"];

/** The empty media state: nothing playing, nothing to ask for. */
export function emptyMediaState(now = Date.now()) {
  return {
    source: null, title: null, artist: null, album: null, playing: false,
    positionMs: null, durationMs: null, updatedAt: now, artwork: null,
    controls: Object.fromEntries(MEDIA_CONTROLS.map((c) => [c, false])),
    shuffle: null, repeat: null, sessions: [], permission: null,
  };
}

/**
 * Coerce whatever a provider returned into the exact section 8.3 shape, so a
 * provider bug can never put an unexpected type (or an internet URL) on the
 * wire. `repeatModes` is an additive field: the repeat values the current
 * source accepts.
 */
export function normalizeMediaState(raw, now = Date.now()) {
  const out = emptyMediaState(now);
  if (!raw || typeof raw !== "object") return out;
  const src = raw.source && typeof raw.source === "object" ? raw.source : null;
  if (src && str(src.id, 64)) {
    out.source = { id: str(src.id, 64), name: str(src.name, 128), appId: str(src.appId, 1024), sessionId: str(src.sessionId, 256) };
    out.title = str(raw.title);
    out.artist = str(raw.artist);
    out.album = str(raw.album);
    out.playing = raw.playing === true;
    out.durationMs = msOrNull(raw.durationMs);
    out.positionMs = msOrNull(raw.positionMs);
    if (out.positionMs !== null && out.durationMs) out.positionMs = Math.min(out.positionMs, out.durationMs);
    out.artwork = typeof raw.artwork === "string" && /^\/api\/media\/artwork\?key=[a-f0-9]{32}$/.test(raw.artwork) ? raw.artwork : null;
    out.shuffle = typeof raw.shuffle === "boolean" ? raw.shuffle : null;
    out.repeat = REPEAT_MODES.includes(raw.repeat) ? raw.repeat : null;
  }
  if (typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)) out.updatedAt = raw.updatedAt;
  const controls = raw.controls && typeof raw.controls === "object" ? raw.controls : {};
  for (const c of MEDIA_CONTROLS) out.controls[c] = controls[c] === true;
  if (Array.isArray(raw.sessions)) {
    out.sessions = raw.sessions.slice(0, 16).filter((s) => s && str(s.sessionId, 256)).map((s) => ({
      sessionId: str(s.sessionId, 256), name: str(s.name, 128), appId: str(s.appId, 1024), title: str(s.title), current: s.current === true,
    }));
  }
  const perm = raw.permission;
  if (perm && typeof perm === "object" && str(perm.player, 32) && ["needed", "denied"].includes(perm.status)) {
    out.permission = { player: str(perm.player, 32), status: perm.status };
  }
  if (Array.isArray(raw.repeatModes)) {
    const modes = REPEAT_MODES.filter((m) => raw.repeatModes.includes(m));
    if (modes.length) out.repeatModes = modes;
  }
  return out;
}

/** Legacy `/api/nowplaying` body derived from a media state. */
export function nowPlayingFromMedia(media) {
  if (!media?.source || !media.title) return null;
  return { title: media.title, artist: media.artist || "", playing: media.playing === true };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function normalizePlayers(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).filter((p) => p && str(p.id, 32) && /^[a-z][a-z0-9-]{0,31}$/.test(p.id)).map((p) => ({
    id: p.id,
    name: str(p.name, 64) || p.id,
    appId: str(p.appId, 1024),
    installed: p.installed === true,
    running: p.running === true,
    permission: PERMISSION_VALUES.includes(p.permission) ? p.permission : "needed",
  }));
}

/**
 * The capability map (DOCK-CONTROLS 7.1) for the snapshot and /api/state.
 *
 * The four legacy booleans keep their meaning: controls and now-playing are on
 * unless the provider opts out explicitly; capture and input exist only when
 * the provider carries those modules. Every new key (`close`, `media`,
 * `volume`, `power`, `spotify`) appears only when the provider declares it, so
 * a missing key means "not offered". `live` is the provider's
 * `featureState()` result: installed/running players, permission-dependent
 * power statuses, whether Spotify is installed.
 */
export function featuresOf(provider, live = {}) {
  const declared = provider?.features || {};
  const out = {
    controls: declared.controls !== false,
    nowPlaying: declared.nowPlaying !== false,
    capture: Boolean(provider?.capture),
    input: Boolean(provider?.input),
  };
  if (declared.close === true) out.close = true;
  const media = declared.media;
  if (media && MEDIA_SOURCES.includes(media.sources)) {
    out.media = {
      sources: media.sources,
      players: normalizePlayers(live?.players ?? media.players ?? []),
      artwork: media.artwork === true,
      sessions: media.sessions === true,
    };
  }
  const volume = declared.volume;
  if (volume && (volume.get || volume.set || volume.mute)) {
    out.volume = { get: volume.get === true, set: volume.set === true, mute: volume.mute === true };
  }
  if (declared.power && typeof declared.power === "object") {
    const power = {};
    for (const verb of POWER_VERBS) {
      if (!Object.hasOwn(declared.power, verb)) continue;
      const status = live?.power?.[verb] ?? declared.power[verb];
      if (POWER_STATUSES.includes(status)) power[verb] = status;
    }
    if (Object.keys(power).length) out.power = power;
  }
  const spotify = declared.spotify;
  if (spotify && typeof spotify === "object") {
    const local = spotify.local || {};
    out.spotify = {
      installed: (live?.spotify?.installed ?? spotify.installed) === true,
      local: {
        nowPlaying: local.nowPlaying === true,
        transport: local.transport === true,
        artwork: local.artwork === true,
        seek: local.seek === true,
        shuffle: local.shuffle === true,
        repeat: local.repeat === true,
      },
      account: { available: false },
    };
  }
  return deepFreeze(out);
}

/** The control verbs a provider advertises (`controlVerbs`, default all). */
export function controlVerbsOf(provider) {
  const declared = provider?.controlVerbs;
  return Array.isArray(declared) ? CONTROL_VERBS.filter((v) => declared.includes(v)) : [...CONTROL_VERBS];
}
