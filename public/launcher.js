import { renderTile, renderTiles } from "./dock.js";
import { tileKey, moveTile, placeTile, isSpacer, lastRealIndex, MAX_SLOTS } from "./tiles.js";

export function normalizeLayout(value = {}) {
  // Upgrade earlier row/column preferences to one of the three supported grids.
  const oldCapacity = Number(value?.columns) * Number(value?.rows);
  const perPage = [4, 6, 8].includes(Number(value?.perPage)) ? Number(value.perPage)
    : value?.perPage === undefined && [4, 6, 8].includes(oldCapacity) ? oldCapacity : 4;
  return {
    perPage,
    columns: perPage / 2,
    rows: 2,
    iconSize: { 4: 160, 6: 138, 8: 116 }[perPage],
    immersive: value?.immersive !== false,
    showLabels: value?.showLabels === true,
    // DOCK-CONTROLS section 4: both switches default on.
    closeButtons: value?.closeButtons !== false,
    miniPlayer: value?.miniPlayer !== false,
    background: ["aurora", "dusk", "ember", "midnight"].includes(value?.background) ? value.background : "aurora",
    theme: ["glass", "frost", "smoke"].includes(value?.theme) ? value.theme : "glass",
  };
}

/**
 * Pages in the dock. Page p shows slots [p * capacity, (p + 1) * capacity):
 * empty pages between icons are kept, trailing empty ones are dropped. While
 * arranging there is one extra empty page on the end to drag icons onto.
 */
export function pageCount(tiles, layout, editing = false) {
  const capacity = layout.columns * layout.rows;
  const last = lastRealIndex(tiles);
  const pages = Math.max(1, Math.ceil((last + 1) / capacity));
  return editing && last >= 0 && pages * capacity < MAX_SLOTS ? pages + 1 : pages;
}

/**
 * An empty slot. While arranging it is a faint outline and a drop target
 * (`data-empty-slot` is its index); otherwise an invisible placeholder that
 * only keeps the grid position. Never focusable, hidden from assistive tech.
 */
function renderEmptySlot(index, editing) {
  return editing
    ? `<div class="slot-empty is-editing" data-empty-slot="${index}" aria-hidden="true"></div>`
    : '<div class="slot-empty" aria-hidden="true"></div>';
}

export function renderPages(state, layout, editing = false) {
  const all = Array.isArray(state?.tiles) ? state.tiles : [];
  // A dock of only empty slots is an empty dock.
  if (lastRealIndex(all) < 0) return renderTiles(state);
  const capacity = layout.columns * layout.rows;
  return Array.from({ length: pageCount(all, layout, editing) }, (_, page) => {
    const start = page * capacity;
    let slots = all.slice(start, start + capacity);
    // A page with a gap on it or before it holds positions the user chose (an
    // icon dropped on page 3's first slot sits in row 1): it keeps the true grid rows.
    const gap = all.slice(0, start + capacity).some(isSpacer);
    // Arranging shows every slot of the page; otherwise the page ends at its last icon.
    if (editing) slots = [...slots, ...Array(capacity - slots.length).fill(null)];
    else while (slots.length && isSpacer(slots[slots.length - 1])) slots.pop();
    // An auto-filled page whose tiles fit in one row is centred vertically (see .dock-page--single-row).
    const single = !gap && slots.length <= layout.columns ? " dock-page--single-row" : "";
    const cells = slots.map((tile, i) => (!tile || isSpacer(tile) ? renderEmptySlot(start + i, editing) : renderTile(tile, { editing, launcher: true })));
    return `<div class="dock-page${single}" role="group" aria-label="Page ${page + 1}">${cells.join("")}</div>`;
  }).join("");
}

/** Drag onto an occupied slot: the dragged tile takes its place and the slots between shift. */
export function moveToTile(tiles, key, targetKey) {
  const from = tiles.findIndex((tile) => tileKey(tile) === key);
  const to = tiles.findIndex((tile) => tileKey(tile) === targetKey);
  return from < 0 || to < 0 ? tiles : moveTile(tiles, key, to - from);
}

/**
 * Drop a dragged tile on slot `index`: an empty slot (a spacer, or past the
 * end) takes it exactly there; an occupied one keeps the shift behaviour.
 */
export function dropOnSlot(tiles, key, index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SLOTS) return tiles;
  if (index >= tiles.length || isSpacer(tiles[index])) return placeTile(tiles, key, index);
  return moveToTile(tiles, key, tileKey(tiles[index]));
}
