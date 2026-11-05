// Pure helpers over a page TextLayer: geometry for selection and highlights, hit testing, search.
// DOM-free and MuPDF-free so they run anywhere and are easy to unit test.
import type { Rect, SearchHit, SearchOptions, TextLayer } from "./types";

/** Bounding box of character i. */
export function charRect(layer: TextLayer, i: number): Rect {
  const q = layer.quads;
  const o = i * 8;
  const xs = [q[o], q[o + 2], q[o + 4], q[o + 6]];
  const ys = [q[o + 1], q[o + 3], q[o + 5], q[o + 7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** One rectangle per line covering characters [start, end). Newline characters are skipped. */
export function rectsForRange(layer: TextLayer, start: number, end: number): Rect[] {
  const out: Rect[] = [];
  let cur: Rect | null = null;
  let curLine = -1;
  for (let i = Math.max(0, start); i < Math.min(end, layer.text.length); i++) {
    if (layer.text[i] === "\n") continue;
    const r = charRect(layer, i);
    if (r[2] - r[0] <= 0 && r[3] - r[1] <= 0) continue;
    if (cur && layer.lines[i] === curLine) {
      cur[0] = Math.min(cur[0], r[0]);
      cur[1] = Math.min(cur[1], r[1]);
      cur[2] = Math.max(cur[2], r[2]);
      cur[3] = Math.max(cur[3], r[3]);
    } else {
      if (cur) out.push(cur);
      cur = [...r];
      curLine = layer.lines[i];
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Character offset closest to a point, as a caret position (0..text.length).
 * Picks the nearest line vertically, then the nearest gap between characters on it.
 * Returns null when the page has no text.
 */
export function caretAt(layer: TextLayer, x: number, y: number): number | null {
  const n = layer.text.length;
  if (!n) return null;
  // Line extents.
  let bestLine = -1;
  let bestDist = Infinity;
  const lineBox = new Map<number, Rect>();
  for (let i = 0; i < n; i++) {
    if (layer.text[i] === "\n") continue;
    const r = charRect(layer, i);
    const l = layer.lines[i];
    const b = lineBox.get(l);
    if (b) {
      b[0] = Math.min(b[0], r[0]);
      b[1] = Math.min(b[1], r[1]);
      b[2] = Math.max(b[2], r[2]);
      b[3] = Math.max(b[3], r[3]);
    } else lineBox.set(l, [...r]);
  }
  for (const [l, b] of lineBox) {
    const dy = y < b[1] ? b[1] - y : y > b[3] ? y - b[3] : 0;
    const dx = x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0;
    const d = dy * 4 + dx; // vertical distance matters most
    if (d < bestDist) {
      bestDist = d;
      bestLine = l;
    }
  }
  if (bestLine < 0) return null;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (layer.lines[i] !== bestLine || layer.text[i] === "\n") continue;
    if (first < 0) first = i;
    last = i;
    const r = charRect(layer, i);
    if (x < (r[0] + r[2]) / 2) return i;
  }
  return last >= 0 ? last + 1 : first;
}

const WORD = /[\p{L}\p{N}_'’-]/u;

/** Range of the word around caret offset i. */
export function wordAt(layer: TextLayer, i: number): [number, number] {
  const t = layer.text;
  let s = Math.min(i, t.length - 1);
  if (s < 0) return [0, 0];
  if (!WORD.test(t[s]) && s > 0 && WORD.test(t[s - 1])) s--;
  if (!WORD.test(t[s])) return [s, s + 1];
  let e = s;
  while (s > 0 && WORD.test(t[s - 1])) s--;
  while (e < t.length && WORD.test(t[e])) e++;
  return [s, e];
}

/** Range of the visual line around caret offset i. */
export function lineAt(layer: TextLayer, i: number): [number, number] {
  const n = layer.text.length;
  const idx = Math.max(0, Math.min(i, n - 1));
  const line = layer.lines[idx];
  let s = idx;
  let e = idx;
  while (s > 0 && layer.lines[s - 1] === line && layer.text[s - 1] !== "\n") s--;
  while (e < n && layer.lines[e] === line && layer.text[e] !== "\n") e++;
  return [s, e];
}

/** Text for a selection, with line breaks kept and trailing whitespace trimmed per line. */
export function textForRange(layer: TextLayer, start: number, end: number): string {
  return layer.text
    .slice(Math.max(0, start), end)
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

export function buildPattern(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  let source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A plain-text query matches across line breaks and runs of spaces.
  if (!opts.regex) source = source.replace(/\s+/g, "\\s+");
  if (opts.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${opts.caseSensitive ? "" : "i"}`);
  } catch {
    return null;
  }
}

/** Finds all matches on one page. Zero-length regex matches are skipped. */
export function searchLayer(layer: TextLayer, page: number, pattern: RegExp, limit = Infinity): SearchHit[] {
  return searchText(layer.text, page, pattern, limit, layer);
}

/** Finds all matches in a page's text. Without the text layer, hits have no rectangles yet (see `hitRects`). */
export function searchText(text: string, page: number, pattern: RegExp, limit = Infinity, layer?: TextLayer): SearchHit[] {
  const hits: SearchHit[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) && hits.length < limit) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    hits.push({
      page,
      start,
      end,
      rects: layer ? rectsForRange(layer, start, end) : [],
      before: snippet(text.slice(Math.max(0, start - 40), start), "start"),
      match: m[0].replace(/\s+/g, " "),
      after: snippet(text.slice(end, end + 60), "end"),
    });
  }
  return hits;
}

/** Rectangles for a hit found by `searchText`, once the page's text layer is at hand. */
export function hitRects(hit: SearchHit, layer: TextLayer): Rect[] {
  return hit.rects.length ? hit.rects : rectsForRange(layer, hit.start, hit.end);
}

function snippet(s: string, side: "start" | "end"): string {
  const flat = s.replace(/\s+/g, " ");
  if (side === "start") {
    const cut = flat.length > 32 ? flat.slice(flat.indexOf(" ", flat.length - 32) + 1) : flat;
    return cut;
  }
  return flat.length > 48 ? flat.slice(0, flat.lastIndexOf(" ", 48)) + "…" : flat;
}
