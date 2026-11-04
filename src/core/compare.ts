// Comparing two PDFs: a word-level text diff across the whole documents (so reflowed text and
// moved page breaks don't show up as changes), plus a pixel diff per page pair for changes that
// aren't text (images, drawings, colours).
import type { Rect, TextLayer } from "./types";

export interface Word {
  text: string;
  page: number;
  rect: Rect;
}

export type ChangeKind = "insert" | "delete" | "replace";

export interface Change {
  kind: ChangeKind;
  /** Text removed from the first document ("" for insertions). */
  before: string;
  /** Text added in the second document ("" for deletions). */
  after: string;
  /** Pages (0-based) the change is on in each document; for an insertion, `aPage` is where it would go. */
  aPage: number;
  bPage: number;
  /** Highlight boxes, per document, in page space. */
  aRects: { page: number; rect: Rect }[];
  bRects: { page: number; rect: Rect }[];
}

export interface TextComparison {
  changes: Change[];
  /** Word counts, for the summary line. */
  aWords: number;
  bWords: number;
  /** True when the documents were too different to diff word by word (pages were compared instead). */
  coarse: boolean;
}

/** Splits a page's text layer into words with bounding boxes. */
export function wordsOf(layer: TextLayer, page: number): Word[] {
  const out: Word[] = [];
  let text = "";
  let box: Rect | null = null;
  const flush = () => {
    if (text && box) out.push({ text, page, rect: box });
    text = "";
    box = null;
  };
  for (let i = 0; i < layer.text.length; i++) {
    const c = layer.text[i];
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    const q = layer.quads.subarray(i * 8, i * 8 + 8);
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const r: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    // A new line inside a "word" (no whitespace between lines) still splits it.
    if (box && i > 0 && layer.lines[i] !== layer.lines[i - 1]) flush();
    text += c;
    box = box ? [Math.min(box[0], r[0]), Math.min(box[1], r[1]), Math.max(box[2], r[2]), Math.max(box[3], r[3])] : r;
  }
  flush();
  return out;
}

const norm = (w: string) => w.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");

/**
 * Myers' O((N+M)·D) diff on token ids, after trimming the common start and end. Returns matched
 * index pairs. Gives up (returns null) beyond `maxD` edits: the saved frontiers grow with D², so
 * this bounds both time and memory for wholesale rewrites.
 */
export function diffTokens(a: number[], b: number[], maxD = 3000): [number, number][] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const core = myers(a.slice(start, endA), b.slice(start, endB), maxD);
  if (!core) return null;
  const out: [number, number][] = [];
  for (let i = 0; i < start; i++) out.push([i, i]);
  for (const [x, y] of core) out.push([x + start, y + start]);
  for (let i = 0; i < a.length - endA; i++) out.push([endA + i, endB + i]);
  return out;
}

function myers(a: number[], b: number[], maxD: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-d..d] as it was before step d.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const get = (d: number, k: number) => trace[d][k + d];
  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const k = x - y;
    const prevK = k === -d || (k !== d && get(d, k - 1) < get(d, k + 1)) ? k + 1 : k - 1;
    const prevX = get(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      matches.push([x - 1, y - 1]);
      x--;
      y--;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    matches.push([x - 1, y - 1]);
    x--;
    y--;
  }
  return matches.reverse();
}

/** Word-level comparison of two documents' words. */
export function compareWords(a: Word[], b: Word[]): TextComparison {
  const exact = compareWordsExact(a, b, 3000);
  if (exact) return { changes: exact, aWords: a.length, bWords: b.length, coarse: false };
  return { changes: coarseChanges(a, b), aWords: a.length, bWords: b.length, coarse: true };
}

function compareWordsExact(a: Word[], b: Word[], maxD: number): Change[] | null {
  const ids = new Map<string, number>();
  const id = (w: Word) => {
    const k = norm(w.text);
    let v = ids.get(k);
    if (v === undefined) ids.set(k, (v = ids.size));
    return v;
  };
  const matches = diffTokens(a.map(id), b.map(id), maxD);
  if (!matches) return null;
  const changes: Change[] = [];
  let ia = 0;
  let ib = 0;
  const emit = (a0: number, a1: number, b0: number, b1: number) => {
    if (a0 === a1 && b0 === b1) return;
    const before = a.slice(a0, a1);
    const after = b.slice(b0, b1);
    // Anchor insertions/deletions to the neighbouring word, so they can be shown and scrolled to.
    const aAnchor = before[0] ?? a[a0] ?? a[a0 - 1];
    const bAnchor = after[0] ?? b[b0] ?? b[b0 - 1];
    changes.push({
      kind: !before.length ? "insert" : !after.length ? "delete" : "replace",
      before: before.map((w) => w.text).join(" "),
      after: after.map((w) => w.text).join(" "),
      aPage: aAnchor?.page ?? 0,
      bPage: bAnchor?.page ?? 0,
      aRects: mergeRects(before),
      bRects: mergeRects(after),
    });
  };
  for (const [ma, mb] of matches) {
    emit(ia, ma, ib, mb);
    ia = ma + 1;
    ib = mb + 1;
  }
  emit(ia, a.length, ib, b.length);
  return changes;
}

/** Joins the boxes of consecutive words on the same line into one highlight. */
function mergeRects(words: Word[]): { page: number; rect: Rect }[] {
  const out: { page: number; rect: Rect }[] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && last.page === w.page) {
      const [x0, y0, x1, y1] = last.rect;
      const h = Math.min(y1 - y0, w.rect[3] - w.rect[1]);
      const sameLine = Math.abs((y0 + y1) / 2 - (w.rect[1] + w.rect[3]) / 2) < h * 0.5;
      if (sameLine && w.rect[0] >= x0 - 1) {
        last.rect = [x0, Math.min(y0, w.rect[1]), Math.max(x1, w.rect[2]), Math.max(y1, w.rect[3])];
        continue;
      }
    }
    out.push({ page: w.page, rect: [...w.rect] as Rect });
  }
  return out;
}

/** When the whole-document diff gives up: diff page by page (page i against page i). */
function coarseChanges(a: Word[], b: Word[]): Change[] {
  const byPage = (ws: Word[]) => {
    const m = new Map<number, Word[]>();
    for (const w of ws) {
      const list = m.get(w.page);
      if (list) list.push(w);
      else m.set(w.page, [w]);
    }
    return m;
  };
  const pa = byPage(a);
  const pb = byPage(b);
  const pages = Math.max(-1, ...pa.keys(), ...pb.keys()) + 1;
  const out: Change[] = [];
  for (let p = 0; p < pages; p++) {
    const wa = pa.get(p) ?? [];
    const wb = pb.get(p) ?? [];
    const sub = compareWordsExact(wa, wb, 2000);
    if (sub) out.push(...sub);
    else {
      out.push({ kind: !wa.length ? "insert" : !wb.length ? "delete" : "replace", before: wa.map((w) => w.text).join(" "), after: wb.map((w) => w.text).join(" "), aPage: p, bPage: p, aRects: mergeRects(wa), bRects: mergeRects(wb) });
    }
  }
  return out;
}

/**
 * Regions where two renderings of a page differ (both grey, same size). Returns boxes in pixels.
 * Small differences (anti-aliasing) are ignored; nearby differing pixels are grouped.
 */
export function diffRegions(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray, width: number, height: number, cell = 8): Rect[] {
  const cw = Math.ceil(width / cell);
  const ch = Math.ceil(height / cell);
  const hot = new Uint8Array(cw * ch);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (Math.abs(a[i] - b[i]) > 48) hot[Math.floor(y / cell) * cw + Math.floor(x / cell)]++;
    }
  }
  // A cell counts when a few of its pixels changed; then join touching cells (8-connected).
  const minPixels = Math.max(2, Math.floor((cell * cell) / 32));
  const seen = new Uint8Array(cw * ch);
  const out: Rect[] = [];
  for (let i = 0; i < hot.length; i++) {
    if (hot[i] < minPixels || seen[i]) continue;
    let x0 = cw;
    let y0 = ch;
    let x1 = 0;
    let y1 = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const cx = j % cw;
      const cy = (j - cx) / cw;
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const n = ny * cw + nx;
          if (!seen[n] && hot[n] >= minPixels) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    out.push([x0 * cell, y0 * cell, Math.min(width, (x1 + 1) * cell), Math.min(height, (y1 + 1) * cell)]);
  }
  return out;
}
