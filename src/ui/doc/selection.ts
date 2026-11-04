import type { TextLayer } from "../../core/types";
import { rectsForRange, textForRange } from "../../core/textlayer";
import type { DocData } from "./docData";

export interface Caret {
  page: number;
  offset: number;
}

export interface TextSelection {
  anchor: Caret;
  focus: Caret;
}

export function ordered(sel: TextSelection): [Caret, Caret] {
  const { anchor: a, focus: f } = sel;
  return a.page < f.page || (a.page === f.page && a.offset <= f.offset) ? [a, f] : [f, a];
}

export function isEmpty(sel: TextSelection | null): boolean {
  if (!sel) return true;
  return sel.anchor.page === sel.focus.page && sel.anchor.offset === sel.focus.offset;
}

/** Character range of the selection on one page, or null if the page isn't part of it. */
export function rangeOnPage(sel: TextSelection, page: number, layer: TextLayer): [number, number] | null {
  const [s, e] = ordered(sel);
  if (page < s.page || page > e.page) return null;
  return [page === s.page ? s.offset : 0, page === e.page ? e.offset : layer.text.length];
}

export function selectionRects(sel: TextSelection | null, page: number, layer: TextLayer | undefined) {
  if (!sel || !layer || isEmpty(sel)) return [];
  const r = rangeOnPage(sel, page, layer);
  return r ? rectsForRange(layer, r[0], r[1]) : [];
}

export async function selectionText(sel: TextSelection, data: DocData): Promise<string> {
  const [s, e] = ordered(sel);
  const parts: string[] = [];
  for (let p = s.page; p <= e.page; p++) {
    const layer = await data.textLayer(p);
    const r = rangeOnPage(sel, p, layer)!;
    parts.push(textForRange(layer, r[0], r[1]));
  }
  return parts.join("\n\n").trim();
}
