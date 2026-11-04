// Page layout: where every page sits in the scrollable canvas, in CSS pixels.
import type { PageSize, ViewRotation } from "../core/types";
import { rotatedSize } from "./geometry";

export type LayoutMode = "single" | "two-page" | "two-page-cover";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  boxes: Box[];
  /** Page indices per row, top to bottom. */
  rows: number[][];
  width: number;
  height: number;
}

export const GAP = 16;
export const PAD = 24;

export function rowsFor(count: number, mode: LayoutMode): number[][] {
  const rows: number[][] = [];
  let i = 0;
  if (mode === "two-page-cover" && count > 0) rows.push([i++]);
  while (i < count) {
    if (mode === "single") rows.push([i++]);
    else {
      rows.push(i + 1 < count ? [i, i + 1] : [i]);
      i += 2;
    }
  }
  return rows;
}

/** Widest row and tallest row in points (unscaled), plus how many gaps a row has. */
export function extents(sizes: PageSize[], rotation: ViewRotation, mode: LayoutMode) {
  let maxRowW = 0;
  let maxGaps = 0;
  for (const row of rowsFor(sizes.length, mode)) {
    const w = row.reduce((s, i) => s + rotatedSize(sizes[i], rotation).width, 0);
    if (w > maxRowW) {
      maxRowW = w;
      maxGaps = row.length - 1;
    }
  }
  return { maxRowW, maxGaps };
}

export function layoutPages(
  sizes: PageSize[],
  rotation: ViewRotation,
  mode: LayoutMode,
  scale: number,
  viewportWidth: number,
): Layout {
  const rows = rowsFor(sizes.length, mode);
  const boxes: Box[] = new Array(sizes.length);
  let maxW = 0;
  const rowWidths = rows.map((row) => {
    const w = row.reduce((s, i) => s + rotatedSize(sizes[i], rotation).width * scale, 0) + GAP * (row.length - 1);
    maxW = Math.max(maxW, w);
    return w;
  });
  const width = Math.max(viewportWidth, maxW + PAD * 2);
  let y = PAD;
  rows.forEach((row, r) => {
    // In two-page modes a lone page sits on the side it would occupy in a spread (cover on the right).
    let x = (width - rowWidths[r]) / 2;
    if (mode !== "single" && row.length === 1 && rows.length > 1) {
      const w = rotatedSize(sizes[row[0]], rotation).width * scale;
      x = mode === "two-page-cover" && r === 0 ? width / 2 + GAP / 2 : width / 2 - GAP / 2 - w;
    }
    let rowH = 0;
    for (const i of row) {
      const s = rotatedSize(sizes[i], rotation);
      const w = s.width * scale;
      const h = s.height * scale;
      boxes[i] = { x, y, w, h };
      x += w + GAP;
      rowH = Math.max(rowH, h);
    }
    // Vertically centre shorter pages in a spread.
    for (const i of row) boxes[i].y = y + (rowH - boxes[i].h) / 2;
    y += rowH + GAP;
  });
  return { boxes, rows, width, height: y - GAP + PAD };
}

/** Index of the row containing scroll position `y`. Rows are sorted by y. */
export function rowAt(layout: Layout, y: number): number {
  let lo = 0;
  let hi = layout.rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.boxes[layout.rows[mid][0]].y - GAP / 2 <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Pages whose box intersects [top, bottom]. */
export function pagesInRange(layout: Layout, top: number, bottom: number): number[] {
  const out: number[] = [];
  if (!layout.rows.length) return out;
  for (let r = rowAt(layout, top); r < layout.rows.length; r++) {
    const row = layout.rows[r];
    const first = layout.boxes[row[0]];
    if (first.y > bottom) break;
    for (const i of row) {
      const b = layout.boxes[i];
      if (b.y + b.h >= top && b.y <= bottom) out.push(i);
    }
  }
  return out;
}
