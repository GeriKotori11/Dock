/**
 * Pure dock rendering.
 *
 * Kept free of DOM APIs and browser globals so the same code runs under Node in
 * the PWA gate. `renderTiles` returns an HTML string; the browser shell is the
 * only thing that touches `document`.
 */

import { icon, controlIcon } from "./icons.js";
import { closeLabels, miniSeekMode, seekAria } from "./dock-controls.js";
import { formatTime, spokenTime } from "./now-playing.js";
import { spotifyTileGlyph } from "./spotify.js";

/** Minimal HTML-escape for text interpolated into the dock. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CONTROL_GLYPH = {
  "volume-up": "🔊",
  "volume-down": "🔉",
  "volume-set": "🎚️",
  "mute-toggle": "🔇",
  "media-play-pause": "⏯️",
  "media-next": "⏭️",
  "media-previous": "⏮️",
  "media-stop": "⏹️",
  "brightness-set": "☀️",
  lock: "🔒",
  sleep: "🌙",
  shutdown: "⏻",
  restart: "🔁",
};

export function glyphFor(tile) {
  if (tile.kind === "control") return CONTROL_GLYPH[tile.verb] || "•";
  const name = String(tile.label || tile.id || "?").trim();
  return name.slice(0, 1).toUpperCase() || "?";
}

export function renderAppIcon(app, lazy = false) {
  const initial = glyphFor({ ...app, label: app.name || app.label });
  return `<span class="app-icon"><span class="app-icon__fallback">${escapeHtml(initial)}</span><img src="/api/apps/icon?v=3&amp;id=${escapeHtml(encodeURIComponent(app.id))}" alt="" width="48" height="48" decoding="async"${lazy ? ' loading="lazy"' : ""}></span>`;
}

/**
 * The close button that sits beside a running app tile (DOCK-CONTROLS 5.1).
 * A sibling, never a child: buttons can't nest. `close.state` is rest,
 * armed, closing or leaving; the slot carries it so CSS can fade the badge,
 * the pill, the icon and the running dot together.
 */
function renderCloseButton(tile, key) {
  const { count = 1, state = "rest", fresh = false } = tile.close;
  const labels = closeLabels(tile.label, count);
  return [
    `<button class="tile__close${fresh ? " is-fresh" : ""}" type="button" data-close-for="${escapeHtml(key)}"`,
    ` aria-label="${escapeHtml(state === "armed" ? labels.armed : labels.rest)}"${state === "closing" ? ' aria-busy="true"' : ""}>`,
    `<span class="tile__close-badge" aria-hidden="true">${icon("close")}<span class="tile__close-spinner"></span></span>`,
    `<span class="tile__close-pill" aria-hidden="true">${icon("close")}${escapeHtml(labels.pill)}</span>`,
    "</button>",
  ].join("");
}

/**
 * Render one tile.
 * In editing mode the tile stops being an action button and grows reorder and
 * remove controls, so a tap cannot launch something while the user is arranging
 * the dock. A running, closable app (`tile.close`) is wrapped in a
 * `.tile-slot` with its close button beside it.
 */
export function renderTile(tile, { editing = false, first = false, last = false, launcher = false } = {}) {
  // An empty slot (the pager draws its Arrange outline): nothing to tap or read.
  if (tile?.kind === "spacer") return '<div class="slot-empty" aria-hidden="true"></div>';
  const unavailable = tile.available === false;
  const running = tile.kind === "app" && tile.running === true && !unavailable;
  // A pinned Spotify playlist or album (DOCK-CONTROLS 12): tap plays it, no close button.
  const spotify = tile.kind === "spotify";
  const classes = ["tile", `tile--${tile.kind}`];
  if (running) classes.push("is-running");
  if (unavailable) classes.push("is-unavailable");
  if (editing) classes.push("is-editing");
  const action = tile.kind === "control" ? "control" : spotify ? "spotify-play" : "launch";
  const hasValue = tile.kind === "control" && tile.value !== undefined && tile.value !== null;
  const key =
    tile.kind === "control"
      ? `control:${tile.verb}${hasValue ? `:${tile.value}` : ""}`
      : spotify ? `spotify:${tile.uri}` : `app:${tile.id}`;
  const actionKey = tile.kind === "control" ? tile.verb : spotify ? tile.uri : tile.id;
  // A valued verb carries its value on the element; tapping a tile with no
  // value would send an incomplete request the host correctly rejects.
  const valueAttr = hasValue ? ` data-value="${escapeHtml(String(tile.value))}"` : "";
  // A pinned tile that needs two taps (Sleep) shows the same armed pill as close.
  const arm = !editing && tile.kind === "control" && tile.arm && !unavailable ? tile.arm : null;
  const glyph = tile.kind === "app" ? renderAppIcon(tile) : spotify ? spotifyTileGlyph(tile) : controlIcon(tile.verb, { playing: tile.playing === true });
  const armPill = arm ? `<span class="tile__arm">${icon(arm.icon || "moon")}${escapeHtml(arm.text)}</span>` : "";

  const body = [
    `<span class="tile__glyph" aria-hidden="true">${glyph}${armPill}</span>`,
    `<span class="tile__label">${escapeHtml(tile.label)}</span>`,
    !editing ? `<span class="tile__hint">${unavailable ? "Not available" : tile.kind === "app" ? running ? "Running" : "Open app" : spotify ? "Spotify" : "Quick action"}</span>` : "",
    running && !editing ? '<span class="tile__dot" aria-hidden="true"></span>' : "",
  ].join("");

  if (!editing || launcher) {
    const name = spotify ? `${tile.label}, Spotify${unavailable ? ", connect Spotify on this computer to play it" : ""}`
      : unavailable ? `${tile.label}, not available on this computer`
      : arm?.armed ? arm.label
      : running ? `${tile.label}, running` : tile.label;
    const close = !editing && running && tile.close ? tile.close : null;
    const closing = close?.state === "closing";
    const button = [
      `<button class="${classes.join(" ")}" type="button"`,
      ` data-action="${editing ? "options" : escapeHtml(action)}" data-key="${escapeHtml(actionKey)}" data-tile-key="${escapeHtml(key)}"${valueAttr}`,
      arm ? ` data-armed="${arm.armed ? "true" : "false"}"` : "",
      ` aria-label="${escapeHtml(name)}"${running ? ' aria-pressed="true"' : ""}${closing ? ' aria-busy="true" aria-disabled="true"' : ""}>`,
      body,
      "</button>",
    ].join("");
    if (!close) return button;
    return `<div class="tile-slot" data-slot-key="${escapeHtml(key)}" data-close-state="${escapeHtml(close.state || "rest")}">${button}${renderCloseButton(tile, key)}</div>`;
  }

  return [
    `<div class="${classes.join(" ")}" data-key="${escapeHtml(key)}">`,
    body,
    '<div class="tile__edit">',
    `<button class="tile__move" type="button" data-action="move-up" data-key="${escapeHtml(key)}"`,
    ` aria-label="Move ${escapeHtml(tile.label)} earlier"${first ? " disabled" : ""}>${icon("left")}</button>`,
    `<button class="tile__remove" type="button" data-action="remove" data-key="${escapeHtml(key)}"`,
    ` aria-label="Remove ${escapeHtml(tile.label)}">${icon("trash")}</button>`,
    `<button class="tile__move" type="button" data-action="move-down" data-key="${escapeHtml(key)}"`,
    ` aria-label="Move ${escapeHtml(tile.label)} later"${last ? " disabled" : ""}>${icon("right")}</button>`,
    "</div>",
    "</div>",
  ].join("");
}

export function renderTiles(state, { editing = false } = {}) {
  // Empty slots are skipped; a dock of only empty slots is an empty dock.
  const tiles = (Array.isArray(state?.tiles) ? state.tiles : []).filter((tile) => tile?.kind !== "spacer");
  if (tiles.length === 0) {
    return `<div class="empty"><span class="empty__icon">${icon("grid")}</span><h3>A little space for your favorites.</h3><p>No tiles pinned yet. Add your everyday apps<br>and controls to make this dock yours.</p><button type="button" class="button button--primary" data-open-picker>${icon("plus")} Add your first app</button></div>`;
  }
  return tiles
    .map((tile, i) =>
      renderTile(tile, { editing, first: i === 0, last: i === tiles.length - 1 }),
    )
    .join("");
}

/** Render the grouped control picker from `availableControls()` output. */
export function renderControlPicker(groups) {
  const list = Array.isArray(groups) ? groups : [];
  if (list.length === 0) return '<li class="picker__empty">No controls available.</li>';
  return list
    .map((group) =>
      [
        `<li class="picker__group">${escapeHtml(group.group)}</li>`,
        ...group.items.map(
          (item) =>
            `<li><button type="button" data-verb="${escapeHtml(item.verb)}"${
              item.value === undefined || item.value === null
                ? ""
                : ` data-value="${escapeHtml(String(item.value))}"`
            }${item.pinned ? " disabled" : ""}><span class="picker__symbol">${controlIcon(item.verb)}</span><span class="picker__name">${escapeHtml(item.label)}</span><span class="picker__add">${icon(item.pinned ? "check" : "plus")}</span></button></li>`,
        ),
      ].join(""),
    )
    .join("");
}

export function renderNowPlaying(np) {
  if (!np || !np.title) return "";
  return [
    '<div class="np">',
    `<span class="np__icon">${icon("music")}</span><div class="np__text"><span class="eyebrow">${np.playing ? "Now playing" : "Paused"}</span>`,
    `<strong class="np__title">${escapeHtml(np.title)}</strong>`,
    np.artist ? `<span class="np__artist">${escapeHtml(np.artist)}</span>` : "",
    `</div><button class="icon-button" type="button" data-action="control" data-key="media-play-pause" aria-label="Play / pause">${icon(np.playing ? "pause" : "play")}</button>`,
    "</div>",
  ].join("");
}

/**
 * The Controls sheet ("Take control"): Sound, Display and Your PC/Mac.
 * Transport lives in the Media sheet, so there is no Playback card. With
 * `power` (from powerCaps) the power buttons follow the host's capability
 * map; without it, the older verbs + allowDestructive rule applies.
 */
export function renderControls(verbs, allowDestructive = true, { power = null, kind = "PC" } = {}) {
  const list = Array.isArray(verbs) ? verbs : [];
  const groups = [
    { title: "Sound", hint: "A little louder. A little quieter.", symbol: "volume", items: [["volume-down", "Quieter"], ["mute-toggle", "Mute"], ["volume-up", "Louder"]] },
    { title: "Display", hint: "Set your built-in screen brightness.", symbol: "sun", items: [["brightness-set", "25%", 25], ["brightness-set", "50%", 50], ["brightness-set", "100%", 100]] },
    { title: `Your ${kind === "Mac" ? "Mac" : "PC"}`, hint: "Shut down and restart ask first.", symbol: "monitor", power: true, items: [["lock", "Lock"], ["sleep", "Sleep"], ["restart", "Restart"], ["shutdown", "Shut down"]] },
  ];
  return groups.map((group) => {
    const items = group.items.filter(([verb]) => group.power && power
      ? Boolean(power[verb])
      : list.includes(verb) && (allowDestructive || !["sleep", "restart", "shutdown"].includes(verb)));
    if (!items.length) return "";
    return `<section class="control-card"><div class="control-card__heading"><span class="control-card__symbol">${icon(group.symbol)}</span><div><h3>${group.title}</h3><p>${group.hint}</p></div></div><div class="control-card__actions">${items.map(([verb, label, value]) => `<button type="button" data-action="control" data-key="${verb}"${value === undefined ? "" : ` data-value="${value}"`}>${controlIcon(verb)}<span>${label}</span></button>`).join("")}</div></section>`;
  }).join("");
}

// ---- media (DOCK-CONTROLS 5.2, 5.3) ----

const PLAYING_LABEL = (playing) => (playing ? "Pause" : "Play");

/** Artwork, or the source app's icon, or the music glyph; an image fades in over its fallback. */
function renderArt(media, { badge = false } = {}) {
  const source = media?.source;
  const fallback = source?.appId
    ? renderAppIcon({ id: source.appId, name: source.name })
    : `<span class="media-glyph">${icon("music")}</span>`;
  if (!media?.artwork) return fallback;
  return [
    `<span class="media-glyph">${icon("music")}</span>`,
    `<img class="art-img" src="${escapeHtml(media.artwork)}" alt="" decoding="async">`,
    badge && source?.appId ? `<span class="media-badge">${renderAppIcon({ id: source.appId, name: source.name })}</span>` : "",
  ].join("");
}

/** The title and second line the mini player shows for a session (5.2). */
export function miniPlayerText(media) {
  const source = media?.source?.name || "";
  if (!media?.title) return { title: source ? `Playing in ${source}` : "Playing", sub: "No track details" };
  if (!media.playing && !media.artist) return { title: media.title, sub: source ? `Paused · ${source}` : "Paused" };
  return { title: media.title, sub: media.artist || source };
}

/** Accessible name of the mini player's open button (11). */
export function miniPlayerLabel(media) {
  const { title } = miniPlayerText(media);
  const by = media?.title && media.artist ? `${title} by ${media.artist}` : title;
  const source = media?.source?.name;
  return `${by}${source ? `, ${source}` : ""}. Open media controls.`;
}

/**
 * The mini player's volume buttons, after Next behind a hairline. `mode` is
 * "level" (with a level chip) or "legacy" (volume verbs, no chip). `mute`
 * ("level", "legacy" or null) adds the mute toggle after Volume up; `muted`
 * (true, false or null when unknown) is its pressed state, which only a
 * "level" host can report.
 */
function renderMiniVolume(mode, online, mute = null, muted = null) {
  if (mode !== "level" && mode !== "legacy") return "";
  const off = online ? "" : " disabled";
  const pressed = mute === "level" && typeof muted === "boolean" ? ` aria-pressed="${muted}"` : "";
  return [
    '<span class="mini__divider" aria-hidden="true"></span>',
    `<div class="mini__vol" role="group" aria-label="Volume" data-mini-vol-mode="${mode}">`,
    mode === "level" ? '<span class="mini__chip" data-mini-chip aria-live="polite"></span>' : "",
    `<button class="mini__btn" type="button" data-mini-vol="down" aria-label="Volume down"${off}>${icon("speaker-minus")}</button>`,
    `<button class="mini__btn" type="button" data-mini-vol="up" aria-label="Volume up"${off}>${icon("speaker-plus")}</button>`,
    mute === "level" || mute === "legacy"
      ? `<button class="mini__btn mini__mute" type="button" data-mini-mute="${mute}" aria-label="${muted === true && mute === "level" ? "Unmute" : "Mute"}"${pressed}${off}>${icon("mute")}</button>`
      : "",
    "</div>",
  ].join("");
}

/**
 * The seek row under the controls: elapsed time, the line, total time. The
 * whole row is the slider's hit area when the source can seek; read-only
 * (no thumb, no slider) otherwise; absent without a duration. Position is
 * painted by the page (`--p`, the elapsed time, aria values), so the markup
 * only changes with the track.
 */
function renderMiniSeek(media, online) {
  const mode = miniSeekMode(media);
  if (!mode) return "";
  const seekable = mode === "seek";
  const bar = [
    '<span class="mini__seek-bar">',
    '<span class="mini__seek-track"><span class="mini__seek-fill"></span></span>',
    seekable ? '<span class="mini__seek-thumb" aria-hidden="true"></span>' : "",
    "</span>",
  ].join("");
  const times = (inner) => `<span class="mini__seek-now" data-mini-seek-now aria-hidden="true">0:00</span>${inner}<span class="mini__seek-end" aria-hidden="true">${formatTime(media.durationMs)}</span>`;
  if (!seekable) return `<div class="mini__seek" data-mini-seek="progress" style="--p:0" aria-hidden="true">${times(bar)}</div>`;
  const aria = seekAria(0, media.durationMs, spokenTime);
  return [
    '<div class="mini__seek is-seekable" data-mini-seek="seek" style="--p:0">',
    times(bar),
    `<div class="mini__seek-hit" data-mini-seek-hit role="slider" tabindex="${online ? 0 : -1}" aria-label="Seek" aria-valuemin="${aria.min}" aria-valuemax="${aria.max}" aria-valuenow="${aria.now}" aria-valuetext="${escapeHtml(aria.text)}"${online ? "" : ' aria-disabled="true"'}></div>`,
    "</div>",
  ].join("");
}

/**
 * The floating mini player (or its inline footer form in classic mode).
 * `mode` comes from miniPlayerMode: hidden, player or permission. `volume`
 * ("level", "legacy" or null) adds the volume buttons; the caller passes it
 * only when miniVolumeShown allows it, and the player then widens. `mute`
 * ("level", "legacy" or null, from miniMuteMode) adds the mute toggle to that
 * group, `muted` its state. A known duration adds the seek row (has-seek).
 */
export function renderMiniPlayer({ mode = "hidden", media = null, permission = null, online = true, volume = null, mute = null, muted = null } = {}) {
  if (mode === "permission" && permission) {
    return [
      '<div class="mini mini--permission" role="region" aria-label="Now playing" data-mode="permission">',
      `<span class="mini__art">${permission.appId ? renderAppIcon({ id: permission.appId, name: permission.name }) : `<span class="media-glyph">${icon("music")}</span>`}</span>`,
      `<span class="mini__text"><span class="mini__title">${escapeHtml(`Allow ${permission.name} control`)}</span></span>`,
      `<button class="button button--primary mini__allow" type="button" data-media-allow${online ? "" : " disabled"}>Allow</button>`,
      `<button class="mini__btn mini__dismiss" type="button" data-media-dismiss aria-label="Not now">${icon("close")}</button>`,
      "</div>",
    ].join("");
  }
  if (mode !== "player" || !media?.active) return "";
  const { title, sub } = miniPlayerText(media);
  const can = (name) => (media.controls?.[name] !== false && online ? "" : " disabled");
  const vol = renderMiniVolume(volume, online, mute, muted);
  const seek = renderMiniSeek(media, online);
  return [
    `<div class="mini${vol ? " mini--wide" : ""}${seek ? " has-seek" : ""}" role="region" aria-label="Now playing" data-mode="player" data-playing="${media.playing ? "true" : "false"}">`,
    '<div class="mini__row">',
    `<button class="mini__open" type="button" data-media-open aria-label="${escapeHtml(miniPlayerLabel(media))}">`,
    `<span class="mini__art" aria-hidden="true">${renderArt(media, { badge: true })}</span>`,
    `<span class="mini__text" aria-hidden="true"><span class="mini__title">${escapeHtml(title)}</span>${sub ? `<span class="mini__sub">${escapeHtml(sub)}</span>` : ""}</span>`,
    "</button>",
    `<button class="mini__btn" type="button" data-media="previous" aria-label="Previous track"${can("previous")}>${icon("previous", "icon--fill")}</button>`,
    `<button class="mini__btn mini__play" type="button" data-media="${media.playing ? "pause" : "play"}" aria-label="${PLAYING_LABEL(media.playing)}"${can("playPause")}>${icon(media.playing ? "pause" : "play", media.playing ? "" : "icon--fill")}</button>`,
    `<button class="mini__btn" type="button" data-media="next" aria-label="Next track"${can("next")}>${icon("next", "icon--fill")}</button>`,
    vol,
    "</div>",
    seek,
    "</div>",
  ].join("");
}

/**
 * The sheet header. Phase B (DOCK-CONTROLS 12) adds `tabs` (the tablist,
 * centred between the source and the close button; the source then drops its
 * "on {computer}" context, frames 21 and 22) and `brand` (the source button's
 * content when no media source applies, e.g. Spotify on the Library tab or
 * while finishing login on the computer).
 */
function renderSheetHeader({ media, caps, online, computer, kind, showOn, sourcesOpen, plain, tabs = "", brand = "" }) {
  const close = `<button class="icon-button media-close" type="button" data-close="media" aria-label="Close media controls">${icon("close")}</button>`;
  const source = !plain && media?.active ? media.source : null;
  const middle = tabs ? `<span class="media-head__spacer"></span>${tabs}<span class="media-head__spacer"></span>` : '<span class="media-head__spacer"></span>';
  if (!source && brand) {
    const context = !online ? `Reconnecting to ${computer}…` : tabs ? "" : `on ${computer}`;
    return `<header class="media-head${tabs ? " has-tabs" : ""}"><div class="media-source">${brand}${context ? `<small>${escapeHtml(context)}</small>` : ""}</div>${middle}${close}</header>`;
  }
  if (!source) {
    const context = online ? "" : `<small class="media-head__context">Reconnecting to ${escapeHtml(computer)}…</small>`;
    return `<header class="media-head"><h2 class="media-head__title">Media</h2>${context}<span class="media-head__spacer"></span>${close}</header>`;
  }
  const sessions = caps?.sessions && Array.isArray(media.sessions) ? media.sessions : [];
  const several = online && sessions.length > 1;
  const chip = `<span class="media-source__chip">${source.appId ? renderAppIcon({ id: source.appId, name: source.name }) : icon("music")}</span>`;
  const context = !online ? `Reconnecting to ${computer}…` : several ? `· ${sessions.length} players` : tabs ? "" : `on ${computer}`;
  const inner = `${chip}<span class="media-source__name">${escapeHtml(source.name)}</span>${context || !tabs ? `<small>${escapeHtml(context)}</small>` : ""}`;
  const button = several
    ? `<button class="media-source" type="button" data-media-sources aria-expanded="${sourcesOpen ? "true" : "false"}" aria-controls="media-sources">${inner}${icon("chevron-down")}</button>`
    : `<div class="media-source">${inner}</div>`;
  const show = showOn && online ? `<button class="media-link" type="button" data-media-show>${icon("open")}<span>Show on ${escapeHtml(kind)}</span></button>` : "";
  const list = several && sourcesOpen
    ? `<div id="media-sources" class="media-sources" role="group" aria-label="Players">${sessions.map((s) => `<button type="button" data-media-select="${escapeHtml(s.sessionId)}"${s.current ? ' aria-current="true"' : ""}><span class="media-source__chip">${s.appId ? renderAppIcon({ id: s.appId, name: s.name }) : icon("music")}</span><span class="media-sources__text"><strong>${escapeHtml(s.name)}</strong>${s.title ? `<small>${escapeHtml(s.title)}</small>` : ""}</span>${s.current ? icon("check") : ""}</button>`).join("")}</div>`
    : "";
  return `<header class="media-head${tabs ? " has-tabs" : ""}">${button}${middle}${show}${close}</header>${list}`;
}

function renderPermissionCard(permission, { computer, online }) {
  const name = permission.name;
  const iconHtml = permission.appId ? renderAppIcon({ id: permission.appId, name }) : `<span class="media-glyph">${icon("music")}</span>`;
  const off = online ? "" : " disabled";
  if (permission.status === "denied") {
    return [
      `<div class="media-perm" data-perm-state="denied"><span class="media-perm__icon">${iconHtml}</span><div class="media-perm__text">`,
      `<h3>${escapeHtml(`${name} control is off on your Mac`)}</h3>`,
      `<p>${escapeHtml(`Turn on WinDock → ${name} in System Settings › Privacy & Security › Automation.`)}</p>`,
      `<div class="media-actions"><button class="button button--primary" type="button" data-perm="settings"${off}>Open Settings on Mac</button></div>`,
      "</div></div>",
    ].join("");
  }
  const asking = permission.asking === true;
  return [
    `<div class="media-perm" data-perm-state="${asking ? "asking" : "needed"}"><span class="media-perm__icon">${iconHtml}</span><div class="media-perm__text">`,
    `<h3>${escapeHtml(`Control ${name} from your phone`)}</h3>`,
    `<p>${escapeHtml(`Your Mac asks once before WinDock can read and control ${name}.`)}</p>`,
    `<ol class="media-steps"><li><span>1</span>Tap Ask on Mac.</li><li><span>2</span>${escapeHtml(`On ${computer}, click OK in the prompt.`)}</li></ol>`,
    asking ? `<p class="media-perm__status" role="status">${escapeHtml(`Waiting for your Mac… Click OK in the prompt on ${computer}.`)}</p>` : "",
    '<div class="media-actions">',
    asking
      ? `<button class="button button--primary" type="button" data-perm="ask" disabled aria-busy="true"><span class="spinner${permission.stopped ? " is-stopped" : ""}" aria-hidden="true"></span>Waiting for your Mac…</button>`
      : `<button class="button button--primary" type="button" data-perm="ask"${off}>Ask on Mac</button>`,
    '<button class="button" type="button" data-perm="later">Not now</button>',
    "</div></div></div>",
  ].join("");
}

function renderNothingPlaying({ media, caps, computer, online }) {
  const off = online ? "" : " disabled";
  const installed = (caps?.players || []).filter((p) => p.installed);
  if (caps?.sources === "apps" && !installed.length) {
    return `<div class="media-empty"><span class="media-empty__glyph">${icon("music")}</span><div><p>${escapeHtml(`WinDock can control Spotify and Music on a Mac. Neither is installed on ${computer}.`)}</p></div></div>`;
  }
  const mac = caps?.sources === "apps";
  const buttons = [];
  if (!mac && (caps?.legacy ? caps.transport?.playPause : true)) {
    buttons.push(`<button class="button button--primary" type="button" data-media="play"${off}>${icon("play", "icon--fill")}Resume last player</button>`);
  }
  for (const player of installed.filter((p) => !p.running && (mac || p.id === "spotify"))) {
    const glyph = player.appId ? `<span class="media-actions__icon">${renderAppIcon({ id: player.appId, name: player.name })}</span>` : "";
    buttons.push(`<button class="button" type="button" data-media-launch="${escapeHtml(player.id)}"${off}>${glyph}${escapeHtml(`Open ${player.name}`)}</button>`);
  }
  const body = mac ? `Open Spotify or Music on ${computer} to control it here.` : `Play something on ${computer} and it will show up here, with its controls.`;
  return [
    `<div class="media-empty"><span class="media-empty__glyph">${icon("music")}</span><div>`,
    "<h3>Nothing playing</h3>",
    `<p>${escapeHtml(body)}</p>`,
    buttons.length ? `<div class="media-actions">${buttons.join("")}</div>` : "",
    "</div></div>",
  ].join("");
}

function renderPlayer(media, { online, like = "", aside = "", upNext = "" }) {
  const c = media.controls || {};
  const off = (enabled) => (enabled && online ? "" : " disabled");
  const toggle = (name, on, label, glyph) => `<button class="media-btn media-btn--toggle" type="button" data-media="${name}" aria-label="${label}" aria-pressed="${on ? "true" : "false"}"${off(true)}>${icon(glyph)}</button>`;
  const ghost = '<span class="media-btn media-btn--ghost" aria-hidden="true"></span>';
  const repeatLabel = `Repeat: ${{ off: "Off", all: "All", one: "One" }[media.repeat] || "Off"}`;
  const progress = media.durationMs
    ? [
      '<div class="media-progress">',
      '<span class="media-time" data-progress-time>0:00</span>',
      `<div class="media-track${c.seek ? " is-seekable" : ""}" data-progress style="--p:0"${c.seek ? "" : ' aria-hidden="true"'}>`,
      '<span class="media-track__fill"></span>',
      c.seek ? `<span class="media-track__head"><span></span></span><input class="media-track__input" type="range" min="0" max="${media.durationMs}" step="1000" value="0" aria-label="Seek" data-seek${off(true)}>` : "",
      "</div>",
      `<span class="media-time">${formatTime(media.durationMs)}</span>`,
      "</div>",
    ].join("")
    : "";
  const { title } = miniPlayerText(media);
  return [
    '<div class="media-body">',
    `<div class="media-art" aria-hidden="true">${renderArt(media)}</div>`,
    '<div class="media-info">',
    like ? `<div class="media-title-row"><h3 class="media-title">${escapeHtml(title)}</h3>${like}</div>` : `<h3 class="media-title">${escapeHtml(title)}</h3>`,
    upNext ? '<div class="media-meta"><div class="media-meta__text">' : "",
    media.title ? (media.artist ? `<p class="media-artist">${escapeHtml(media.artist)}</p>` : "") : '<p class="media-artist">No track details</p>',
    media.album ? `<p class="media-album">${escapeHtml(media.album)}</p>` : "",
    upNext ? `</div>${upNext}</div>` : "",
    progress,
    '<div class="media-transport">',
    c.shuffle ? toggle("shuffle", media.shuffle, "Shuffle", "shuffle") : ghost,
    `<button class="media-btn" type="button" data-media="previous" aria-label="Previous track"${off(c.previous !== false)}>${icon("previous", "icon--fill")}</button>`,
    `<button class="media-btn media-btn--play" type="button" data-media="${media.playing ? "pause" : "play"}" aria-label="${PLAYING_LABEL(media.playing)}"${off(c.playPause !== false)}>${icon(media.playing ? "pause" : "play", media.playing ? "" : "icon--fill")}</button>`,
    `<button class="media-btn" type="button" data-media="next" aria-label="Next track"${off(c.next !== false)}>${icon("next", "icon--fill")}</button>`,
    c.repeat ? toggle("repeat", media.repeat !== "off", repeatLabel, media.repeat === "one" ? "repeat-one" : "repeat") : ghost,
    "</div>",
    "</div>",
    aside,
    "</div>",
  ].join("");
}

/**
 * The Media sheet's header and body for one state: permission card, player,
 * or nothing playing (5.3). The volume row is separate (renderVolumeRow) so a
 * drag is never interrupted by a re-render. Progress values are filled in by
 * the page after rendering, so the markup only changes when the state does.
 */
export function renderMediaSheet({ media = null, caps = null, permission = null, online = true, computer = "your computer", kind = "PC", showOn = false, sourcesOpen = false, tabs = "", brand = "", like = "", aside = "", upNext = "", body = null } = {}) {
  // Phase B: with tabs, the body sits in the Now playing tab panel; `body`
  // replaces it (another tab's panel lives outside, so it is "" there).
  const panel = (html) => (tabs ? `<div class="sp-tabpanel" id="sp-tabpanel" role="tabpanel" aria-labelledby="sp-tab-now">${html}</div>` : html);
  const plainHeader = () => renderSheetHeader({ media, caps, online, computer, kind, plain: true, tabs, brand });
  if (body !== null) {
    const sourced = media?.active && !brand;
    return renderSheetHeader({ media, caps, online, computer, kind, showOn: false, sourcesOpen, plain: !sourced, tabs, brand }) + body;
  }
  if (permission) {
    return plainHeader() + panel(renderPermissionCard(permission, { computer, online }));
  }
  if (media?.active) {
    return renderSheetHeader({ media, caps, online, computer, kind, showOn, sourcesOpen, tabs }) + panel(renderPlayer(media, { online, like, aside, upNext }));
  }
  return plainHeader() + panel(renderNothingPlaying({ media, caps, computer, online }));
}

/** The system volume row: a slider (new hosts), three buttons (older hosts) or nothing (6.2). */
export function renderVolumeRow({ mode = null, online = true } = {}) {
  const off = online ? "" : " disabled";
  if (mode === "slider") {
    return [
      '<div class="media-volume" data-volume-mode="slider">',
      `<button class="icon-button media-volume__mute" type="button" data-volume-mute aria-label="Mute" aria-pressed="false"${off}>${icon("volume")}</button>`,
      '<div class="range" data-volume-range style="--p:0">',
      '<span class="range__fill"></span><span class="range__head"><span></span></span>',
      `<input class="range__input" type="range" min="0" max="100" step="1" value="0" aria-label="Volume" aria-valuetext="0 percent" data-volume-input${off}>`,
      "</div>",
      '<span class="media-volume__value" data-volume-value>–</span>',
      "</div>",
    ].join("");
  }
  if (mode === "buttons") {
    return [
      '<div class="media-volume media-volume--buttons" data-volume-mode="buttons" role="group" aria-label="Volume">',
      ...[["volume-down", "quieter", "Quieter"], ["mute-toggle", "mute", "Mute"], ["volume-up", "volume", "Louder"]].map(([verb, glyph, label]) =>
        `<button class="button" type="button" data-media-control="${verb}"${off}>${icon(glyph)}<span>${label}</span></button>`),
      "</div>",
    ].join("");
  }
  return "";
}
