/**
 * Windows platform provider.
 *
 * Two distinct channels, chosen deliberately:
 *
 *  - Inventory / telemetry (read-only) runs a CONSTANT PowerShell script that
 *    emits JSON. No caller input is ever interpolated into these strings, so
 *    the script text is fixed at module load and cannot be influenced.
 *
 *  - Every action (launch, focus, close, control) is dispatched to
 *    WinDockHelper.exe as an argv ARRAY. Arguments are passed as separate argv
 *    entries, never concatenated, so a path containing `& shutdown /s` is one
 *    opaque argument rather than a second command.
 *
 * The helper is where Win32 P/Invoke lives (SetForegroundWindow, SendInput for
 * media keys, ExtractIconEx, the GlobalSystemMediaTransportControls session).
 * Keeping it behind argv means this file stays pure, parseable and testable on
 * any OS, which is what the inventory and launch gates exercise.
 */

import { CONTROL_VERBS, MEDIA_SEEK_MAX_MS, REPEAT_MODES, hostError, mediaArtworkPath, validArtworkKey, validateControl } from "./contract.js";
import { ARTWORK_MAX_BYTES, ARTWORK_MAX_PX, imageInfo } from "./artwork.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createWindowsCapture } from "./capture.js";
import { createWindowsInput } from "./input.js";

/** Constant PowerShell: classic shortcuts and the Windows packaged-app catalog. */
export const INVENTORY_PS = [
  "$ErrorActionPreference='SilentlyContinue';",
  "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);",
  "$out=@();",
  "$roots=@(",
  "  [Environment]::GetFolderPath('CommonStartMenu'),",
  "  [Environment]::GetFolderPath('StartMenu')",
  ");",
  "$sh=New-Object -ComObject WScript.Shell;",
  "foreach($r in $roots){",
  "  if(-not $r){continue};",
  "  Get-ChildItem -LiteralPath $r -Recurse -Filter *.lnk | ForEach-Object {",
  "    $lk=$sh.CreateShortcut($_.FullName);",
  "    if($lk.TargetPath -and $lk.TargetPath.ToLower().EndsWith('.exe')){",
  "      $out+=[pscustomobject]@{",
  "        name=$_.BaseName; target=$lk.TargetPath;",
  "        args=$lk.Arguments; icon=$lk.IconLocation; source='startmenu'",
  "      }",
  "    }",
  "  }",
  "};",
  "$catalog=(New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder');",
  "if($catalog){foreach($item in $catalog.Items()) {",
  "  $aumid=$item.ExtendedProperty('System.AppUserModel.ID');",
  "  if($aumid -and $aumid.Contains('!')){",
  "    $out+=[pscustomobject]@{name=$item.Name; target=('shell:AppsFolder\\'+$aumid); args=''; icon=''; source='packaged'}",
  "  }",
  "}};",
  "$out | ConvertTo-Json -Compress -Depth 3",
].join(" ");

/** Constant PowerShell: processes owning a top-level window. */
export const RUNNING_PS = [
  "$ErrorActionPreference='SilentlyContinue';",
  "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);",
  "Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class WinDockIdentity { [DllImport(\"kernel32.dll\")] static extern IntPtr OpenProcess(uint access, bool inherit, int id); [DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr handle); [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr handle, ref uint length, StringBuilder value); public static string Read(int id) { var handle=OpenProcess(0x1000,false,id); if(handle==IntPtr.Zero)return null; try { uint length=256; var value=new StringBuilder(256); return GetApplicationUserModelId(handle,ref length,value)==0?value.ToString():null; } finally { CloseHandle(handle); } } }';",
  "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |",
  "  Select-Object Id,ProcessName,MainWindowTitle,",
  "    @{n='Handle';e={[int64]$_.MainWindowHandle}},",
  "    @{n='Path';e={$_.Path}},",
  "    @{n='AppUserModelId';e={[WinDockIdentity]::Read($_.Id)}} |",
  "  ConvertTo-Json -Compress -Depth 3",
].join(" ");

/** Constant PowerShell: CPU, memory and battery snapshot. */
export const STATS_PS = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$os=Get-CimInstance Win32_OperatingSystem;",
  "$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;",
  "$bat=Get-CimInstance Win32_Battery | Select-Object -First 1;",
  "[pscustomobject]@{",
  "  cpu=$cpu;",
  "  memTotal=$os.TotalVisibleMemorySize;",
  "  memFree=$os.FreePhysicalMemory;",
  "  battery=$(if($bat){$bat.EstimatedChargeRemaining}else{$null});",
  "  charging=$(if($bat){$bat.BatteryStatus -eq 2}else{$null})",
  "} | ConvertTo-Json -Compress",
].join(" ");

export const POWERSHELL = "powershell.exe";
/** -NoProfile keeps a user profile script from altering output or timing. */
export const PS_FLAGS = Object.freeze([
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
]);

/** Control verbs the helper implements, mapped to its argv verbs. */
export const HELPER_CONTROL = Object.freeze({
  "volume-up": ["control", "volume-up"],
  "volume-down": ["control", "volume-down"],
  "volume-set": ["control", "volume-set"],
  "mute-toggle": ["control", "mute-toggle"],
  "media-play-pause": ["control", "media-play-pause"],
  "media-next": ["control", "media-next"],
  "media-previous": ["control", "media-previous"],
  "media-stop": ["control", "media-stop"],
  "brightness-set": ["control", "brightness-set"],
  lock: ["control", "lock"],
  sleep: ["control", "sleep"],
  shutdown: ["control", "shutdown"],
  restart: ["control", "restart"],
});

/** A Windows app id is stable across restarts: the lowercased target path. */
export function appIdFromTarget(target) {
  return String(target || "").trim().toLowerCase().replace(/\\/g, "/");
}

const PACKAGED_PREFIX = "shell:AppsFolder\\";
export function packagedAppId(target) {
  if (typeof target !== "string" || !target.toLowerCase().startsWith(PACKAGED_PREFIX.toLowerCase())) return null;
  const aumid = target.slice(PACKAGED_PREFIX.length);
  return aumid.length <= 128 && !/\s/.test(aumid) && /^[a-z0-9][a-z0-9.-]*_[a-z0-9]+![a-z0-9][a-z0-9._-]*$/i.test(aumid) ? aumid : null;
}

/** Keep different shortcut modes/profiles without changing argument-free IDs. */
export function appIdFromLaunch(target, args = "") {
  const id = appIdFromTarget(target);
  const argumentsText = String(args || "").trim();
  return argumentsText ? `${id}#${createHash("sha256").update(argumentsText).digest("hex").slice(0, 16)}` : id;
}

function jsonArray(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || parsed === undefined) return [];
  // ConvertTo-Json emits a bare object, not a 1-element array, for one result.
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Parse the inventory JSON into deduplicated app records.
 * Exported separately from the provider so the gate can drive it with fixtures.
 */
export function parseInstalled(raw) {
  const byId = new Map();
  for (const row of jsonArray(raw)) {
    const target = typeof row?.target === "string" ? row.target.trim() : "";
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!target || !name) continue;
    const packaged = packagedAppId(target);
    if (!packaged && (/^shell:/i.test(target) || !/\.exe$/i.test(target))) continue;
    const args = packaged ? "" : typeof row?.args === "string" ? row.args.trim() : "";
    const id = appIdFromLaunch(target, args);
    // Start Menu wins over registry: it carries the user-facing display name.
    const existing = byId.get(id);
    if (existing && existing.source === "startmenu" && row.source !== "startmenu") continue;
    byId.set(id, {
      id,
      name,
      target,
      args,
      icon: typeof row?.icon === "string" ? row.icon.trim() : "",
      source: packaged ? "packaged" : row?.source === "registry" ? "registry" : "startmenu",
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
}

/**
 * Parse running-window JSON into stable identities.
 * A process is only a dock-visible app when it owns a top-level window.
 */
export function parseRunning(raw) {
  const out = [];
  const seen = new Set();
  for (const row of jsonArray(raw)) {
    const pid = Number(row?.Id);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const handle = Number(row?.Handle);
    if (!Number.isInteger(handle) || handle === 0) continue;
    const path = typeof row?.Path === "string" ? row.Path.trim() : "";
    const procName = typeof row?.ProcessName === "string" ? row.ProcessName.trim() : "";
    const packagedTarget = PACKAGED_PREFIX + (typeof row?.AppUserModelId === "string" ? row.AppUserModelId : "");
    if (!path && !procName) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push({
      id: packagedAppId(packagedTarget) ? appIdFromTarget(packagedTarget) : path ? appIdFromTarget(path) : `proc:${procName.toLowerCase()}`,
      name: procName,
      title: typeof row?.MainWindowTitle === "string" ? row.MainWindowTitle.trim() : "",
      pid,
      handle,
      path,
      ...(packagedAppId(packagedTarget) ? { activationId: row.AppUserModelId } : {}),
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Parse the stats snapshot into normalized percentages. */
export function parseStats(raw) {
  const [row] = jsonArray(raw);
  if (!row) return { cpu: null, memory: null, battery: null, charging: null };
  const total = Number(row.memTotal);
  const free = Number(row.memFree);
  const memory =
    Number.isFinite(total) && Number.isFinite(free) && total > 0
      ? Math.round(((total - free) / total) * 100)
      : null;
  const cpu = Number.isFinite(Number(row.cpu)) ? Math.round(Number(row.cpu)) : null;
  const battery = Number.isFinite(Number(row.battery)) ? Math.round(Number(row.battery)) : null;
  return {
    cpu,
    memory,
    battery,
    charging: typeof row.charging === "boolean" ? row.charging : null,
  };
}

/**
 * Build the argv for a control action. Returned as an array so the caller can
 * assert it exactly; numeric values are stringified only at the boundary and
 * only after `validateControl` has proven they are integers in range.
 */
export function controlArgv(verb, value) {
  const checked = validateControl(verb, value);
  if (!checked.ok) throw new Error(checked.error);
  const base = HELPER_CONTROL[checked.verb];
  if (!base) throw new Error(`unmapped control verb: ${checked.verb}`);
  return checked.value === null ? [...base] : [...base, String(checked.value)];
}

/** Verbs declared by the contract but not mapped here (must stay empty). */
export function unmappedVerbs() {
  return CONTROL_VERBS.filter((v) => !HELPER_CONTROL[v]);
}

/**
 * Process names (lowercase, no .exe) a phone must never be offered to close
 * (DOCK-CONTROLS 5.1): the shell that owns the desktop, taskbar and File
 * Explorer windows, WinDock's own tray and helper, and shell hosts whose
 * windows belong to other apps.
 */
export const WINDOWS_NOT_CLOSABLE = Object.freeze([
  "explorer",
  "windocktray",
  "windockhelper",
  "applicationframehost",
  "shellexperiencehost",
  "startmenuexperiencehost",
  "searchhost",
  "searchapp",
  "textinputhost",
  "lockapp",
  "dwm",
  "csrss",
  "winlogon",
]);

/** Whether a running Windows app may be closed from the dock. */
export function windowsClosable(entry) {
  const name = typeof entry?.name === "string" ? entry.name.toLowerCase().replace(/\.exe$/, "") : "";
  if (WINDOWS_NOT_CLOSABLE.includes(name)) return false;
  const path = typeof entry?.path === "string" ? entry.path.toLowerCase().replace(/\//g, "\\") : "";
  return !/\\(explorer|windocktray|windockhelper)\.exe$/.test(path);
}

/**
 * The installed Spotify app in a Windows catalog: the classic installer
 * (`...\Spotify\Spotify.exe`) or the Microsoft Store package. Null when absent.
 */
export function findSpotify(apps) {
  if (!Array.isArray(apps)) return null;
  return apps.find((app) => typeof app?.id === "string"
    && (/(^|\/)spotify\.exe$/.test(app.id) || /spotifyab\.spotifymusic_[a-z0-9]+!/.test(app.id))) || null;
}

/** Media actions the system media keys can do (fallback for an older helper). */
const WINDOWS_MEDIA_KEYS = Object.freeze({ toggle: "media-play-pause", next: "media-next", previous: "media-previous" });

/** Largest `media-state` output accepted (16 sessions of clipped strings fit easily). */
export const MEDIA_STATE_MAX_CHARS = 256 * 1024;
/** Largest `media-artwork` output accepted: base64 of the 2 MB cap plus the envelope. */
export const MEDIA_ARTWORK_MAX_CHARS = Math.ceil(ARTWORK_MAX_BYTES / 3) * 4 + 1024;
const SESSION_ID = /^[\x21-\x7e]{1,256}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MEDIA_STATUSES = ["playing", "paused", "stopped", "changing", "opened", "closed"];
const COMMAND_ACTIONS = ["play", "pause", "toggle", "next", "previous", "seek", "shuffle", "repeat"];

/** One JSON object from bounded helper output, else null. */
function boundedObject(raw, max) {
  const text = String(raw ?? "").trim();
  if (!text || text.length > max) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const text = (v, max = 512) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const ms = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** The WinDock app id for a media session's source, when it can be told. */
export function sessionAppId(sessionId, path) {
  const aumid = packagedAppId(PACKAGED_PREFIX + sessionId);
  if (aumid) return appIdFromTarget(PACKAGED_PREFIX + aumid);
  return typeof path === "string" && /^[a-z]:\\.+\.exe$/i.test(path) ? appIdFromTarget(path) : null;
}

/**
 * Parse `media-state` output: `{ current, sessions: [...] }` with every field
 * type-checked. Null for malformed or oversized output.
 */
export function parseMediaState(raw) {
  const row = boundedObject(raw, MEDIA_STATE_MAX_CHARS);
  if (!row || !Array.isArray(row.sessions)) return null;
  const seen = new Set();
  const sessions = [];
  for (const s of row.sessions.slice(0, 16)) {
    if (!s || typeof s !== "object" || typeof s.sessionId !== "string" || !SESSION_ID.test(s.sessionId) || seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    const c = s.controls && typeof s.controls === "object" ? s.controls : {};
    sessions.push({
      sessionId: s.sessionId,
      name: text(s.name, 128),
      appId: sessionAppId(s.sessionId, s.path),
      current: s.current === true,
      title: text(s.title),
      artist: text(s.artist),
      album: text(s.album),
      status: MEDIA_STATUSES.includes(s.status) ? s.status : "closed",
      positionMs: ms(s.positionMs),
      durationMs: ms(s.durationMs),
      updatedAt: ms(s.updatedAt),
      shuffle: typeof s.shuffle === "boolean" ? s.shuffle : null,
      repeat: REPEAT_MODES.includes(s.repeat) ? s.repeat : null,
      controls: {
        previous: c.previous === true,
        next: c.next === true,
        playPause: c.playPause === true,
        seek: c.seek === true,
        shuffle: c.shuffle === true,
        repeat: c.repeat === true,
      },
      artworkKey: validArtworkKey(s.artworkKey) ? s.artworkKey : null,
    });
  }
  const current = typeof row.current === "string" && seen.has(row.current) ? row.current : null;
  for (const s of sessions) s.current = s.sessionId === current;
  return { current, sessions };
}

/**
 * Parse `media-artwork` output for `key`: PNG/JPEG bytes at most 512 px and
 * 2 MB whose key still matches (a track change mints a new key). Else null.
 */
export function parseMediaArtwork(raw, key) {
  const row = boundedObject(raw, MEDIA_ARTWORK_MAX_CHARS);
  if (!row || row.ok !== true || row.key !== key || typeof row.data !== "string" || !BASE64.test(row.data)) return null;
  const bytes = Buffer.from(row.data, "base64");
  if (!bytes.length || bytes.length > ARTWORK_MAX_BYTES) return null;
  const info = imageInfo(bytes);
  if (!info || info.mime !== row.mime || !(info.width > 0 && info.height > 0) || Math.max(info.width, info.height) > ARTWORK_MAX_PX) return null;
  return { mime: info.mime, bytes };
}

/** An older helper answers a verb it does not know with this on stderr. */
const unknownVerb = (err) => /unknown verb/.test(String(err?.stderr || ""));

/**
 * Create the Windows provider.
 * @param {object} opts
 * @param {(file:string,args:string[])=>Promise<{stdout:string}>} opts.exec
 * @param {string} [opts.helperPath] path to WinDockHelper.exe
 */
export function createWindowsProvider({ exec, helperPath = process.env.WINDOCK_HELPER || fileURLToPath(new URL("../../WinDockHelper.exe", import.meta.url)), now = Date.now } = {}) {
  if (typeof exec !== "function") throw new Error("windows provider requires exec");

  const ps = (script) => exec(POWERSHELL, [...PS_FLAGS, script]);
  const helper = (args) => exec(helperPath, args);
  // DDC/CI monitor firmware can reject overlapping requests.
  let brightnessQueue = Promise.resolve();

  async function nowPlaying() {
    const { stdout } = await helper(["nowplaying"]);
    const [row] = jsonArray(stdout);
    if (!row) return null;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) return null;
    return {
      title,
      artist: typeof row.artist === "string" ? row.artist.trim() : "",
      playing: row.playing === true,
    };
  }

  function parseVolume(stdout) {
    const row = boundedObject(stdout, 4096);
    const scalar = typeof row?.volume === "number" ? row.volume : NaN;
    return {
      level: Number.isFinite(scalar) && scalar >= 0 && scalar <= 1 ? Math.round(scalar * 100) : null,
      muted: typeof row?.muted === "boolean" ? row.muted : null,
    };
  }

  async function volume() {
    const { stdout } = await helper(["volume"]);
    return parseVolume(stdout);
  }

  // The session a phone chose ("select"); shown and commanded until it ends.
  let selectedSession = null;
  const artworkKeys = new Map(); // key -> sessionId, newest last

  function rememberArtwork(key, sessionId) {
    artworkKeys.delete(key);
    artworkKeys.set(key, sessionId);
    while (artworkKeys.size > 64) artworkKeys.delete(artworkKeys.keys().next().value);
    return mediaArtworkPath(key);
  }

  /** `media-state`, or null when the helper is older or its output is unusable. */
  async function mediaState() {
    try {
      return parseMediaState((await helper(["media-state"])).stdout);
    } catch {
      return null;
    }
  }

  /** The shown session: the chosen one, Windows' current one, a playing one, any with a track. */
  function chooseSession(sessions) {
    const titled = sessions.filter((s) => s.title);
    if (selectedSession && !sessions.some((s) => s.sessionId === selectedSession)) selectedSession = null;
    return titled.find((s) => s.sessionId === selectedSession)
      || titled.find((s) => s.current)
      || titled.find((s) => s.status === "playing")
      || titled[0]
      || null;
  }

  function stateFor(session, sessions) {
    const at = now();
    const updatedAt = session.updatedAt !== null && session.updatedAt <= at ? session.updatedAt : at;
    return {
      source: { id: "system", name: session.name, appId: session.appId, sessionId: session.sessionId },
      title: session.title,
      artist: session.artist,
      album: session.album,
      playing: session.status === "playing",
      positionMs: session.positionMs,
      durationMs: session.durationMs,
      updatedAt,
      artwork: session.artworkKey ? rememberArtwork(session.artworkKey, session.sessionId) : null,
      controls: { ...session.controls, seek: session.controls.seek && session.durationMs > 0 },
      shuffle: session.controls.shuffle ? session.shuffle : null,
      repeat: session.controls.repeat ? session.repeat : null,
      ...(session.controls.repeat ? { repeatModes: [...REPEAT_MODES] } : {}),
      sessions: sessionList(sessions, session),
      permission: null,
    };
  }

  const sessionList = (sessions, shown) => sessions.map((s) => ({
    sessionId: s.sessionId, name: s.name, appId: s.appId, title: s.title, current: s === shown,
  }));

  /** Media through the old helper verbs: title, artist, playing; media keys. */
  async function legacyMedia() {
    const np = await nowPlaying().catch(() => null);
    // Media keys reach whichever session Windows considers current, so
    // play/pause works even with nothing listed ("Resume last player").
    const controls = { previous: true, next: true, playPause: true, seek: false, shuffle: false, repeat: false };
    if (!np) return { source: null, controls, sessions: [], permission: null };
    return {
      source: { id: "system", name: null, appId: null, sessionId: null },
      title: np.title,
      artist: np.artist,
      album: null,
      playing: np.playing,
      positionMs: null,
      durationMs: null,
      artwork: null,
      controls,
      shuffle: null,
      repeat: null,
      sessions: [],
      permission: null,
    };
  }

  async function legacyCommand(action) {
    let verb = WINDOWS_MEDIA_KEYS[action];
    if (action === "play" || action === "pause") {
      // One key toggles: only press it when it moves toward the request.
      const np = await nowPlaying().catch(() => null);
      const playing = np?.playing === true;
      verb = (action === "play" ? !playing : playing) ? "media-play-pause" : null;
      if (!verb) return;
    }
    if (!verb) throw hostError(501, { error: "action unavailable" });
    await helper(controlArgv(verb, null));
  }

  /** The `media-command` value argument, re-checked here (the host checked it first). */
  function commandValue(action, value) {
    if (action === "seek") {
      if (!Number.isInteger(value) || value < 0 || value > MEDIA_SEEK_MAX_MS) throw hostError(400, { error: "seek takes an integer position in ms" });
      return String(value);
    }
    if (action === "shuffle") {
      if (typeof value !== "boolean") throw hostError(400, { error: "shuffle takes true or false" });
      return String(value);
    }
    if (action === "repeat") {
      if (!REPEAT_MODES.includes(value)) throw hostError(400, { error: "repeat takes off, all or one" });
      return value;
    }
    return "";
  }

  async function mediaCommand(action, value, sessionId) {
    if (sessionId !== null && sessionId !== undefined && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))) {
      throw hostError(400, { error: "sessionId must be a short string" });
    }
    if (action === "select") {
      const id = typeof value === "string" ? value : sessionId;
      if (typeof id !== "string" || !SESSION_ID.test(id)) throw hostError(400, { error: "select takes a sessionId" });
      const state = await mediaState();
      if (!state) throw hostError(501, { error: "action unavailable" });
      if (!state.sessions.some((s) => s.sessionId === id)) throw hostError(404, { error: "unknown session" });
      selectedSession = id;
      return;
    }
    if (!COMMAND_ACTIONS.includes(action)) throw hostError(501, { error: "action unavailable" });
    const arg = commandValue(action, value);
    const target = sessionId || selectedSession || "";
    const argv = ["media-command", action];
    if (arg || target) argv.push(arg);
    if (target) argv.push(target);
    let stdout;
    try {
      ({ stdout } = await helper(argv));
    } catch (err) {
      if (!unknownVerb(err)) throw err;
      // An older helper: the media keys still cover play/pause/next/previous.
      return legacyCommand(action);
    }
    const row = boundedObject(stdout, 4096);
    if (row?.ok === true) return;
    switch (row?.error) {
      case "no-session": throw hostError(404, { error: "no media session" });
      case "unknown-session":
        if (target === selectedSession) selectedSession = null;
        throw hostError(404, { error: "unknown session" });
      case "rejected": throw hostError(501, { error: "action unavailable" });
      default: throw hostError(502, { error: "media helper failed" });
    }
  }

  return {
    id: "windows",
    displayName: "Windows",
    capture: createWindowsCapture({ helperPath }),
    input: createWindowsInput({ helperPath }),
    // Media comes from the system media sessions (any app, Spotify
    // included): every session is listed and can be chosen, with artwork,
    // timeline, shuffle and repeat when the session reports them. Seek,
    // shuffle and repeat are per-state controls, so the Spotify entry only
    // promises what every Spotify session does: track, transport, artwork.
    features: Object.freeze({
      close: true,
      media: Object.freeze({ sources: "system", artwork: true, sessions: true }),
      volume: Object.freeze({ get: true, set: true, mute: true }),
      power: Object.freeze({ lock: "ready", sleep: "ready", restart: "ready", shutdown: "ready" }),
      spotify: Object.freeze({ local: Object.freeze({ nowPlaying: true, transport: true, artwork: true, seek: false, shuffle: false, repeat: false }) }),
    }),

    async appIcon(app) {
      const aumid = packagedAppId(app.target);
      const { stdout } = await helper(aumid ? ["icon-packaged", aumid] : ["icon", app.target, app.icon || ""]);
      const [row] = jsonArray(stdout);
      if (typeof row?.png !== "string" || row.png.length > 512 * 1024) return null;
      const bytes = Buffer.from(row.png, "base64");
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? bytes : null;
    },

    async listInstalledApps() {
      const { stdout } = await ps(INVENTORY_PS);
      return parseInstalled(stdout);
    },

    async listRunningApps() {
      const { stdout } = await ps(RUNNING_PS);
      return parseRunning(stdout).map((entry) => ({ ...entry, closable: windowsClosable(entry) }));
    },

    async launchApp(app) {
      const target = typeof app === "string" ? app : app?.target;
      if (typeof target !== "string" || !target.trim()) {
        throw new Error("launchApp requires a target path");
      }
      if (/^shell:/i.test(target)) {
        const aumid = packagedAppId(target);
        if (!aumid) throw new Error("invalid packaged app identifier");
        await helper(["launch-packaged", aumid]);
        return;
      }
      // argv array: the target is one argument even if it contains spaces,
      // quotes, ampersands or newlines.
      const args = typeof app === "object" && typeof app?.args === "string" ? app.args : "";
      await helper(args ? ["launch", target, args] : ["launch", target]);
    },

    async focusApp(running) {
      const pid = Number(running?.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error("focusApp requires a positive integer pid");
      }
      if (typeof running.activationId === "string") {
        const aumid = packagedAppId(PACKAGED_PREFIX + running.activationId);
        if (!aumid) throw new Error("invalid packaged app identifier");
        await helper(["launch-packaged", aumid]);
        return;
      }
      await helper(["focus", String(pid)]);
    },

    async closeApp(running) {
      const pid = Number(running?.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error("closeApp requires a positive integer pid");
      }
      const { stdout } = await helper(["close", String(pid)]);
      const windows = boundedObject(stdout, 4096)?.windows;
      // How many windows were asked to close (an older helper reports nothing).
      return { windows: Number.isInteger(windows) && windows >= 0 ? windows : null };
    },

    async control(verb, value) {
      const args = controlArgv(verb, value);
      if (verb === "brightness-set") {
        const pending = brightnessQueue.then(() => helper(args));
        brightnessQueue = pending.catch(() => {});
        try { await pending; }
        catch (cause) {
          const error = new Error("Could not adjust display brightness. Check that DDC/CI is enabled in your monitor's menu and its picture mode allows brightness changes.", { cause });
          error.status = 503;
          throw error;
        }
      } else await helper(args);
      return { ok: true, verb };
    },

    nowPlaying,

    // ---- dock controls ----

    async featureState({ installed = null, running = [] } = {}) {
      const spotify = findSpotify(installed);
      if (!spotify) return { players: [], spotify: { installed: false } };
      const isRunning = (running || []).some((r) => r.id === spotify.id || String(r.name || "").toLowerCase() === "spotify");
      return {
        players: [{ id: "spotify", name: "Spotify", appId: spotify.id, installed: true, running: isRunning, permission: "not-required" }],
        spotify: { installed: true },
      };
    },

    async sessionState() {
      try {
        const row = boundedObject((await helper(["session-locked"])).stdout, 4096);
        return typeof row?.locked === "boolean" ? { locked: row.locked } : null;
      } catch {
        return null;
      }
    },

    async media() {
      const state = await mediaState();
      if (!state) return legacyMedia();
      const shown = chooseSession(state.sessions);
      if (shown) return stateFor(shown, state.sessions);
      // Nothing with a track: media keys can still resume the last player.
      return {
        source: null,
        updatedAt: now(),
        controls: { previous: false, next: false, playPause: true, seek: false, shuffle: false, repeat: false },
        sessions: sessionList(state.sessions, null),
        permission: null,
      };
    },

    mediaCommand,

    async mediaArtwork(key) {
      if (!validArtworkKey(key)) return null;
      const sessionId = artworkKeys.get(key);
      if (!sessionId) return null;
      try {
        return parseMediaArtwork((await helper(["media-artwork", sessionId])).stdout, key);
      } catch {
        return null;
      }
    },

    volume,

    async setVolume({ level, muted } = {}) {
      const hasLevel = Number.isInteger(level) && level >= 0 && level <= 100;
      if (!hasLevel && typeof muted !== "boolean") throw new Error("setVolume needs level or muted");
      if (hasLevel) await helper(controlArgv("volume-set", level));
      if (typeof muted === "boolean") return parseVolume((await helper(["volume-mute", String(muted)])).stdout);
      return volume();
    },

    async systemStats() {
      const { stdout } = await ps(STATS_PS);
      return parseStats(stdout);
    },
  };
}
