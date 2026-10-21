// Poll only while the dock is usable. Manual refreshes share any pending request
// so a slow native media provider cannot accumulate concurrent requests.
// Allow the host's 20-second native timeout to finish before retrying a stalled read.
//
// Commands (`command(run)`) order against polls: a poll whose request started
// before the latest command's reply arrived is discarded, and while a command
// runs polls are held (the optimistic state stays) for up to `holdMs`. The
// command's own reply, when it carries state, is applied as the shared state.
// Without this an in-flight poll overwrote the optimistic play/pause state
// and the glyph flickered pause -> play -> pause.
export function createNowPlayingPoller({ load, onChange, isActive, intervalMs = 2000, timeoutMs = 25000, holdMs = 2000, now = Date.now }) {
  let pending = null, pendingTick = 0, controller = null, stopped = false;
  let tick = 0, commandsRunning = 0, commandStartedAt = 0, commandDoneTick = 0;
  const stale = (startTick) => startTick < commandDoneTick || (commandsRunning > 0 && now() - commandStartedAt < holdMs);
  function refresh() {
    if (stopped) return Promise.resolve();
    // A pending poll from before the latest command can't answer for it: queue a fresh one.
    if (pending) return pendingTick < commandDoneTick ? pending.catch(() => {}).then(refresh) : pending;
    controller = new AbortController();
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startTick = pendingTick = ++tick;
    pending = Promise.resolve()
      .then(() => load(signal))
      .then((media) => { if (!stopped && !stale(startTick)) onChange(media); })
      .finally(() => { clearTimeout(timeout); pending = null; controller = null; });
    return pending;
  }
  const timer = setInterval(() => {
    if (isActive()) refresh().catch(() => { /* Retry transient failures on the next poll. */ });
  }, intervalMs);
  return {
    refresh,
    /** Run a command; its resolved value (a media state, or null for none) becomes the shared state. */
    async command(run) {
      commandsRunning += 1;
      commandStartedAt = now();
      ++tick;
      let settled = false;
      try {
        const reply = await run();
        commandsRunning -= 1; settled = true;
        commandDoneTick = ++tick;
        if (!stopped && reply !== null && reply !== undefined) onChange(reply);
        return reply;
      } finally {
        if (!settled) { commandsRunning -= 1; commandDoneTick = ++tick; }
      }
    },
    stop() { stopped = true; clearInterval(timer); controller?.abort(); },
  };
}

/** The media poller (DOCK-CONTROLS 8.3) is the same single-flight design. */
export const createMediaPoller = createNowPlayingPoller;

const REPEAT = new Set(["off", "all", "one"]);
const str = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");
const count = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

/** Artwork only from the host's own artwork route: no other URL reaches an <img>. */
export function safeArtwork(value) {
  return typeof value === "string" && /^\/api\/media\/artwork\?[A-Za-z0-9=&%._~-]*$/.test(value) ? value : null;
}

/**
 * One media model for both hosts. `/api/media` (new hosts) and
 * `/api/nowplaying` (older hosts, via `fromNowPlaying`) both normalise to it;
 * `active` says whether a session exists.
 */
export function normalizeMedia(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const src = value.source && typeof value.source === "object" ? value.source : null;
  const source = src && (str(src.name) || str(src.id))
    ? { id: str(src.id) || null, name: str(src.name) || str(src.id), appId: str(src.appId) || null, sessionId: str(src.sessionId) || null }
    : null;
  const controls = value.controls && typeof value.controls === "object" ? value.controls : {};
  const durationMs = count(value.durationMs);
  const positionMs = count(value.positionMs);
  const permission = value.permission && typeof value.permission === "object" && str(value.permission.player)
    ? { player: str(value.permission.player), status: str(value.permission.status) }
    : null;
  return {
    active: source !== null,
    legacy: false,
    source,
    title: str(value.title),
    artist: str(value.artist),
    album: str(value.album),
    playing: value.playing === true,
    positionMs: durationMs ? Math.min(positionMs ?? 0, durationMs) : null,
    durationMs: durationMs || null,
    artwork: safeArtwork(value.artwork),
    controls: {
      previous: controls.previous !== false,
      next: controls.next !== false,
      playPause: controls.playPause !== false,
      seek: controls.seek === true && Boolean(durationMs),
      shuffle: controls.shuffle === true,
      repeat: controls.repeat === true,
    },
    shuffle: value.shuffle === true,
    repeat: REPEAT.has(value.repeat) ? value.repeat : "off",
    sessions: Array.isArray(value.sessions)
      ? value.sessions.filter((s) => s && typeof s === "object" && str(s.sessionId)).map((s) => ({
        sessionId: str(s.sessionId), name: str(s.name) || "Player", appId: str(s.appId) || null, title: str(s.title), current: s.current === true,
      }))
      : [],
    permission,
  };
}

/** An older host's `/api/nowplaying` answer, with transport from its verbs. */
export function fromNowPlaying(np, transport = {}) {
  const title = str(np?.title);
  return {
    ...normalizeMedia(null),
    active: Boolean(title),
    legacy: true,
    title,
    artist: str(np?.artist),
    playing: Boolean(title) && np?.playing === true,
    controls: {
      previous: transport.previous === true,
      next: transport.next === true,
      playPause: transport.playPause === true,
      seek: false, shuffle: false, repeat: false,
    },
  };
}

/** Position now, interpolated from the last poll while playing; null without a timeline. */
export function mediaPosition(media, receivedAt, now) {
  if (!media?.durationMs || media.positionMs === null || media.positionMs === undefined) return null;
  const elapsed = media.playing ? Math.max(0, now - receivedAt) : 0;
  return Math.max(0, Math.min(media.durationMs, media.positionMs + elapsed));
}

/** 72000 → "1:12"; an hour or more → "1:02:03". */
export function formatTime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** 72000 → "1 minute 12 seconds", for aria-valuetext. */
export function spokenTime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const part = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [h && part(h, "hour"), m && part(m, "minute"), (s || (!h && !m)) && part(s, "second")].filter(Boolean).join(" ");
}
