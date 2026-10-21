/**
 * Pure dock-list operations.
 *
 * The dock is an ordered list of slots, and every edit is a pure transformation
 * of that list: add, remove, move. A slot holds a real tile or an empty
 * `{ kind: "spacer" }`, so an icon can sit on page 3 while page 2 has gaps.
 * Trailing spacers are always trimmed. Keeping these free of the DOM means the editing
 * behaviour is provable headlessly instead of only by tapping a phone.
 *
 * Every function returns a NEW array and never mutates its input, so a failed
 * server round-trip can be rolled back by simply keeping the old list.
 */

/**
 * Stable identity for a tile within the dock.
 * A valued control is keyed by verb AND value, so "Volume 25%" and
 * "Volume 75%" are two distinct tiles rather than one colliding pair.
 */
export function tileKey(tile, index) {
  if (!tile || typeof tile !== "object") return "";
  // An empty slot has no identity of its own: its key is its position (for
  // rendering only, never persisted), so `list.map(tileKey)` stays unique and
  // a bare `tileKey(spacer)` never matches a real tile's key.
  if (tile.kind === "spacer") return `spacer:${Number.isInteger(index) ? index : ""}`;
  if (tile.kind === "spotify") return `spotify:${tile.uri}`;
  if (tile.kind !== "control") return `app:${tile.id}`;
  return tile.value === undefined || tile.value === null
    ? `control:${tile.verb}`
    : `control:${tile.verb}:${tile.value}`;
}

/**
 * Strip runtime-only fields before sending tiles back to the host.
 * `running` is computed per request by the server; echoing it back would
 * persist a snapshot of live state into the config file.
 */
export function toWireTiles(tiles) {
  if (!Array.isArray(tiles)) return [];
  return trimSpacers(tiles
    .map((tile) => {
      if (!tile || typeof tile !== "object") return null;
      if (tile.kind === "spacer") return { kind: "spacer" };
      if (tile.kind === "control") {
        const out = { kind: "control", verb: tile.verb, label: tile.label };
        if (tile.value !== undefined && tile.value !== null) out.value = tile.value;
        return out;
      }
      if (tile.kind === "app") {
        return {
          kind: "app",
          id: tile.id,
          target: tile.target,
          label: tile.label,
          args: tile.args || "",
          icon: tile.icon || "",
        };
      }
      if (tile.kind === "spotify") {
        // A pinned playlist or album (DOCK-CONTROLS 12): the cover is a host image key.
        const out = { kind: "spotify", uri: tile.uri, label: tile.label };
        if (tile.image) out.image = tile.image;
        return out;
      }
      return null;
    })
    .filter(Boolean));
}

/** Most real tiles a dock holds; spacers fill the remaining slots up to MAX_SLOTS. */
export const MAX_REAL_TILES = 64;
export const MAX_SLOTS = 128;

export function isSpacer(tile) {
  return Boolean(tile) && tile.kind === "spacer";
}

/** The real tiles, gaps skipped. */
export function realTiles(tiles) {
  return (Array.isArray(tiles) ? tiles : []).filter((tile) => tile && typeof tile === "object" && !isSpacer(tile));
}

/** Drop trailing empty slots (a dock of only spacers becomes empty). */
export function trimSpacers(tiles) {
  const list = Array.isArray(tiles) ? [...tiles] : [];
  while (list.length && isSpacer(list[list.length - 1])) list.pop();
  return list;
}

/** Index of the last real tile, or -1 for an empty dock. */
export function lastRealIndex(tiles) {
  const list = Array.isArray(tiles) ? tiles : [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && !isSpacer(list[i])) return i;
  return -1;
}

/** A new tile goes into the first empty slot, else on the end; never past MAX_REAL_TILES. */
function insertTile(list, tile) {
  if (realTiles(list).length >= MAX_REAL_TILES) return list;
  const gap = list.findIndex(isSpacer);
  if (gap === -1) return [...list, tile];
  const next = [...list];
  next[gap] = tile;
  return next;
}

/**
 * Move a tile into slot `index`, which must be empty (a spacer, or past the
 * end, in which case the list is padded with spacers). Its old slot becomes
 * a spacer. Returns the list unchanged for an occupied target, an absent
 * key, or an index outside the MAX_SLOTS range.
 */
export function placeTile(tiles, key, index) {
  const list = toWireTiles(tiles);
  const from = list.findIndex((t) => tileKey(t) === key);
  if (from === -1 || !Number.isInteger(index) || index < 0 || index >= MAX_SLOTS || index === from) return list;
  if (index < list.length && !isSpacer(list[index])) return list;
  const next = [...list];
  while (next.length <= index) next.push({ kind: "spacer" });
  next[index] = next[from];
  next[from] = { kind: "spacer" };
  return trimSpacers(next);
}

export function hasTile(tiles, key) {
  return (Array.isArray(tiles) ? tiles : []).some((t) => !isSpacer(t) && tileKey(t) === key);
}

/**
 * Add an app tile into the first empty slot, else on the end. Adding one that
 * is already pinned, or to a dock already holding MAX_REAL_TILES, is a no-op.
 */
export function addAppTile(tiles, app) {
  const list = toWireTiles(tiles);
  if (!app || typeof app !== "object" || !app.id || !app.target) return list;
  const tile = {
    kind: "app",
    id: app.id,
    target: app.target,
    label: app.name || app.label || app.id,
    args: app.args || "",
    icon: app.icon || "",
  };
  if (hasTile(list, tileKey(tile))) return list;
  return insertTile(list, tile);
}

/**
 * Add a control tile (first empty slot, else the end). Adding one that is
 * already pinned, or to a full dock, is a no-op.
 * `value` is required for verbs that take one (volume-set, brightness-set) and
 * is stored on the tile so tapping it sends a complete control request.
 */
export function addControlTile(tiles, verb, label, value = null) {
  const list = toWireTiles(tiles);
  if (typeof verb !== "string" || !verb) return list;
  const tile = { kind: "control", verb, label: label || verb };
  if (value !== null && value !== undefined) {
    if (!Number.isInteger(value)) return list;
    tile.value = value;
  }
  if (hasTile(list, tileKey(tile))) return list;
  return insertTile(list, tile);
}

/**
 * Add a Spotify playlist or album tile (first empty slot, else the end) `{ kind: "spotify", uri, label, image? }`.
 * Only playlist and album URIs qualify; adding one already pinned is a no-op.
 */
export function addSpotifyTile(tiles, tile) {
  const list = toWireTiles(tiles);
  if (!tile || typeof tile !== "object" || !/^spotify:(playlist|album):[A-Za-z0-9]{1,64}$/.test(String(tile.uri || ""))) return list;
  const next = { kind: "spotify", uri: tile.uri, label: tile.label || "Spotify" };
  if (tile.image) next.image = tile.image;
  if (hasTile(list, tileKey(next))) return list;
  return insertTile(list, next);
}

/**
 * Remove the tile with this key, leaving an empty slot so the icons after it
 * keep their places (trailing gaps are trimmed). Removing an absent key is a no-op.
 */
export function removeTile(tiles, key) {
  return toWireTiles(toWireTiles(tiles).map((t) => (tileKey(t) === key ? { kind: "spacer" } : t)));
}

/**
 * Move a tile by `delta` slots, clamped to the list bounds; the slots between
 * shift by one. A move of one swaps it with its neighbouring slot, spacer or tile.
 * Returns the list unchanged when the tile is absent or already at the edge.
 */
export function moveTile(tiles, key, delta) {
  const list = toWireTiles(tiles);
  const from = list.findIndex((t) => tileKey(t) === key);
  if (from === -1 || !Number.isInteger(delta) || delta === 0) return list;
  const to = Math.min(list.length - 1, Math.max(0, from + delta));
  if (to === from) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return trimSpacers(next);
}

/**
 * The controls offered in the picker, grouped for a phone-sized list.
 * Verbs are advertised by the host in `state.verbs`; this catalogue supplies
 * the human labels and grouping, and any verb the host does not advertise is
 * filtered out rather than offered and then rejected.
 */
export const CONTROL_CATALOG = Object.freeze([
  {
    group: "Volume",
    items: [
      { verb: "volume-up", label: "Volume Up" },
      { verb: "volume-down", label: "Volume Down" },
      { verb: "mute-toggle", label: "Mute" },
      { verb: "volume-set", label: "Volume 25%", value: 25 },
      { verb: "volume-set", label: "Volume 50%", value: 50 },
      { verb: "volume-set", label: "Volume 75%", value: 75 },
    ],
  },
  {
    group: "Media",
    items: [
      { verb: "media-play-pause", label: "Play / Pause" },
      { verb: "media-next", label: "Next Track" },
      { verb: "media-previous", label: "Previous" },
      { verb: "media-stop", label: "Stop" },
    ],
  },
  {
    group: "Display",
    items: [
      { verb: "brightness-set", label: "Brightness 25%", value: 25 },
      { verb: "brightness-set", label: "Brightness 50%", value: 50 },
      { verb: "brightness-set", label: "Brightness 100%", value: 100 },
    ],
  },
  {
    group: "Power",
    items: [
      { verb: "lock", label: "Lock" },
      { verb: "sleep", label: "Sleep" },
      { verb: "restart", label: "Restart" },
      { verb: "shutdown", label: "Shut Down" },
    ],
  },
]);

/** Every DISTINCT verb this catalogue can offer, flattened. */
export function catalogVerbs() {
  return [...new Set(CONTROL_CATALOG.flatMap((g) => g.items.map((i) => i.verb)))];
}

/**
 * The catalogue narrowed to what the host actually advertises, with tiles the
 * user already pinned marked so the picker can show them as added.
 */
export function availableControls(advertised, tiles) {
  const allowed = new Set(Array.isArray(advertised) ? advertised : []);
  const list = toWireTiles(tiles);
  return CONTROL_CATALOG.map((group) => ({
    group: group.group,
    items: group.items
      .filter((item) => allowed.has(item.verb))
      .map((item) => ({
        ...item,
        pinned: hasTile(list, tileKey({ kind: "control", verb: item.verb, value: item.value })),
      })),
  })).filter((group) => group.items.length > 0);
}
