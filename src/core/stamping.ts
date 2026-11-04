// Page marks added to page content: headers and footers (incl. page and Bates numbers), watermarks and
// backgrounds. Each mark is its own content stream, recorded in the page's /PDForgeMarks so it can be
// replaced or removed later without touching the original content.
import * as mupdf from "mupdf";
import type { Color } from "./types";

export type MarkKind = "headerfooter" | "watermark" | "background";

export interface HeaderFooterSpec {
  /** [left, center, right] for the top and bottom margins. Tokens: {page} {pages} {date} {file} {bates}. */
  top: [string, string, string];
  bottom: [string, string, string];
  fontSize: number;
  color: Color;
  /** Distance from the page edge, in points. */
  margin: number;
  /** Number shown on the first selected page for {page}. */
  startNumber: number;
  bates?: { prefix: string; start: number; digits: number; suffix: string };
  fileName: string;
  pages: number[];
}

export interface WatermarkSpec {
  text?: string;
  /** PNG/JPEG for an image watermark. */
  image?: Uint8Array;
  fontSize: number;
  color: Color;
  opacity: number;
  /** Degrees, counter-clockwise. */
  rotation: number;
  /** Image width as a fraction of the page width. */
  scale: number;
  behind: boolean;
  pages: number[];
}

export interface BackgroundSpec {
  color: Color;
  opacity: number;
  pages: number[];
}

const MARKS = "PDForgeMarks";
const helvetica = () => new mupdf.Font("Helvetica");

/** Maps "view space" (the page as displayed: origin bottom-left, y up, rotation applied) to PDF space. */
function viewMatrix(page: mupdf.PDFObject): { m: number[]; w: number; h: number } {
  const box = boxOf(page);
  const [x0, y0, x1, y1] = box;
  const cw = x1 - x0;
  const ch = y1 - y0;
  const rot = ((((safe(() => page.getInheritable("Rotate").asNumber(), 0) || 0) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  switch (rot) {
    case 90:
      return { m: [0, 1, -1, 0, x1, y0], w: ch, h: cw };
    case 180:
      return { m: [-1, 0, 0, -1, x1, y1], w: cw, h: ch };
    case 270:
      return { m: [0, -1, 1, 0, x0, y1], w: ch, h: cw };
    default:
      return { m: [1, 0, 0, 1, x0, y0], w: cw, h: ch };
  }
}

function boxOf(page: mupdf.PDFObject): [number, number, number, number] {
  let b = safe(() => page.getInheritable("CropBox"), null);
  if (!b || !b.isArray()) b = page.getInheritable("MediaBox");
  const v = [0, 1, 2, 3].map((i) => b!.get(i).asNumber());
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

/** The page's own resources dictionary (copied from an inherited one if needed). */
function ownResources(pdf: mupdf.PDFDocument, page: mupdf.PDFObject): mupdf.PDFObject {
  const own = page.get("Resources");
  if (own.isDictionary()) return own;
  const res = pdf.newDictionary();
  const inherited = safe(() => page.getInheritable("Resources"), null);
  if (inherited && inherited.isDictionary()) inherited.forEach((v, k) => res.put(k, v));
  const ref = pdf.addObject(res);
  page.put("Resources", ref);
  return ref;
}

function sub(res: mupdf.PDFObject, pdf: mupdf.PDFDocument, key: string): mupdf.PDFObject {
  let d = res.get(key);
  if (!d.isDictionary()) {
    d = pdf.newDictionary();
    res.put(key, d);
  }
  return d;
}

function addMarkStream(pdf: mupdf.PDFDocument, page: mupdf.PDFObject, kind: MarkKind, content: string, behind: boolean) {
  const stream = pdf.addStream(content, {});
  const contents = page.get("Contents");
  const list = pdf.newArray();
  // Wrap the original content in q/Q so our marks aren't affected by its graphics state.
  const existing: mupdf.PDFObject[] = [];
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) existing.push(contents.get(i));
  else if (!contents.isNull()) existing.push(contents);
  if (behind) {
    list.push(stream);
    existing.forEach((c) => list.push(c));
  } else {
    if (!isWrapped(page)) {
      list.push(pdf.addStream("q\n", {}));
      existing.forEach((c) => list.push(c));
      list.push(pdf.addStream("\nQ\n", {}));
      page.put("PDForgeWrapped", true);
    } else existing.forEach((c) => list.push(c));
    list.push(stream);
  }
  page.put("Contents", list);
  let marks = page.get(MARKS);
  if (!marks.isDictionary()) {
    marks = pdf.newDictionary();
    page.put(MARKS, marks);
  }
  let arr = marks.get(kind);
  if (!arr.isArray()) {
    arr = pdf.newArray();
    marks.put(kind, arr);
  }
  arr.push(stream);
}

/** Appends a content stream to a page, isolating the existing content's graphics state first. */
export function appendContent(pdf: mupdf.PDFDocument, page: mupdf.PDFObject, content: string) {
  const contents = page.get("Contents");
  const list = pdf.newArray();
  const existing: mupdf.PDFObject[] = [];
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) existing.push(contents.get(i));
  else if (!contents.isNull()) existing.push(contents);
  if (!isWrapped(page)) {
    list.push(pdf.addStream("q\n", {}));
    existing.forEach((c) => list.push(c));
    list.push(pdf.addStream("\nQ\n", {}));
    page.put("PDForgeWrapped", true);
  } else existing.forEach((c) => list.push(c));
  list.push(pdf.addStream(content, {}));
  page.put("Contents", list);
}

export { ownResources };

function isWrapped(page: mupdf.PDFObject) {
  return safe(() => page.get("PDForgeWrapped").asBoolean(), false);
}

/** Removes marks of a kind (all kinds when omitted) from pages. Returns how many pages had some. */
export function removeMarks(pdf: mupdf.PDFDocument, kind?: MarkKind, pages?: number[]): number {
  let n = 0;
  const list = pages ?? Array.from({ length: pdf.countPages() }, (_, i) => i);
  for (const p of list) {
    const page = pdf.findPage(p);
    const marks = page.get(MARKS);
    if (!marks.isDictionary()) continue;
    const kinds: MarkKind[] = kind ? [kind] : ["headerfooter", "watermark", "background"];
    const doomed = new Set<number>();
    for (const k of kinds) {
      const arr = marks.get(k);
      if (arr.isArray()) for (let i = 0; i < arr.length; i++) doomed.add(arr.get(i).asIndirect());
      marks.delete(k);
    }
    if (!doomed.size) continue;
    n++;
    const contents = page.get("Contents");
    if (contents.isArray()) {
      const keep = pdf.newArray();
      for (let i = 0; i < contents.length; i++) if (!doomed.has(contents.get(i).asIndirect())) keep.push(contents.get(i));
      page.put("Contents", keep);
    }
  }
  return n;
}

/** Which kinds of marks a document has, for "Remove…" menu items. */
export function markKinds(pdf: mupdf.PDFDocument): MarkKind[] {
  const found = new Set<MarkKind>();
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    const marks = pdf.findPage(p).get(MARKS);
    if (marks.isDictionary()) marks.forEach((v, k) => v.isArray() && v.length && found.add(k as MarkKind));
  }
  return [...found];
}

function textWidth(font: mupdf.Font, text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!)) * size;
  return w;
}

/** Unicode → WinAnsi byte for the 0x80–0x9F range (smart quotes, dashes, € …). */
const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Encodes for Helvetica with WinAnsi; returns the escaped string and whether anything had to be replaced. */
export function encodeWinAnsi(text: string): { s: string; lossy: boolean } {
  let lossy = false;
  let s = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const byte = c >= 0x20 && c < 0x7f ? c : c >= 0xa0 && c <= 0xff ? c : WIN_ANSI[c];
    if (byte === undefined) {
      s += "?";
      lossy = true;
    } else if (byte === 0x28 || byte === 0x29 || byte === 0x5c) s += "\\" + ch;
    else if (byte < 0x80) s += ch;
    else s += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return { s, lossy };
}

const encode = encodeWinAnsi;

const n2 = (v: number) => String(Math.round(v * 1000) / 1000);
const rgb = (c: Color) => c.map(n2).join(" ");

function fontResource(pdf: mupdf.PDFDocument, res: mupdf.PDFObject): string {
  const fonts = sub(res, pdf, "Font");
  if (!fonts.get("PDFgHelv").isDictionary()) {
    fonts.put("PDFgHelv", pdf.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  }
  return "PDFgHelv";
}

function alphaResource(pdf: mupdf.PDFDocument, res: mupdf.PDFObject, opacity: number): string {
  const name = `PDFgA${Math.round(opacity * 100)}`;
  const gs = sub(res, pdf, "ExtGState");
  if (!gs.get(name).isDictionary()) gs.put(name, pdf.addObject({ Type: "ExtGState", ca: opacity, CA: opacity }));
  return name;
}

export function expandTokens(t: string, vars: { page: number; pages: number; date: string; file: string; bates: string }): string {
  return t.replace(/\{(page|pages|date|file|bates)\}/g, (_, k: keyof typeof vars) => String(vars[k]));
}

/** Adds headers and footers (replacing earlier ones on those pages). Returns true if some characters couldn't be shown. */
export function addHeaderFooter(pdf: mupdf.PDFDocument, spec: HeaderFooterSpec): boolean {
  removeMarks(pdf, "headerfooter", spec.pages);
  const font = helvetica();
  const total = pdf.countPages();
  const date = new Date().toLocaleDateString();
  let lossy = false;
  spec.pages.forEach((p, i) => {
    const page = pdf.findPage(p);
    const res = ownResources(pdf, page);
    const f = fontResource(pdf, res);
    const { m, w, h } = viewMatrix(page);
    const bates = spec.bates ? `${spec.bates.prefix}${String(spec.bates.start + i).padStart(spec.bates.digits, "0")}${spec.bates.suffix}` : "";
    const vars = { page: spec.startNumber + i, pages: total, date, file: spec.fileName, bates };
    let content = `q ${m.map(n2).join(" ")} cm BT /${f} ${n2(spec.fontSize)} Tf ${rgb(spec.color)} rg\n`;
    const place = (text: string, slot: number, top: boolean) => {
      if (!text.trim()) return;
      const t = expandTokens(text, vars);
      const tw = textWidth(font, t, spec.fontSize);
      const x = slot === 0 ? spec.margin : slot === 1 ? (w - tw) / 2 : w - spec.margin - tw;
      const y = top ? h - spec.margin - spec.fontSize * 0.75 : spec.margin;
      const e = encode(t);
      lossy ||= e.lossy;
      content += `1 0 0 1 ${n2(x)} ${n2(y)} Tm (${e.s}) Tj\n`;
    };
    spec.top.forEach((t, k) => place(t, k, true));
    spec.bottom.forEach((t, k) => place(t, k, false));
    content += "ET Q\n";
    addMarkStream(pdf, page, "headerfooter", content, false);
  });
  return lossy;
}

export function addWatermark(pdf: mupdf.PDFDocument, spec: WatermarkSpec): boolean {
  removeMarks(pdf, "watermark", spec.pages);
  const font = helvetica();
  let lossy = false;
  const img = spec.image ? new mupdf.Image(spec.image) : null;
  let imgRef: mupdf.PDFObject | null = null;
  for (const p of spec.pages) {
    const page = pdf.findPage(p);
    const res = ownResources(pdf, page);
    const gs = alphaResource(pdf, res, spec.opacity);
    const { m, w, h } = viewMatrix(page);
    const rad = (spec.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let content = `q ${m.map(n2).join(" ")} cm /${gs} gs\n`;
    if (img) {
      imgRef ??= pdf.addImage(img);
      const xo = sub(res, pdf, "XObject");
      xo.put("PDFgWm", imgRef);
      const iw = w * spec.scale;
      const ih = iw * (img.getHeight() / img.getWidth());
      // Rotate around the page centre.
      content += `1 0 0 1 ${n2(w / 2)} ${n2(h / 2)} cm ${n2(cos)} ${n2(sin)} ${n2(-sin)} ${n2(cos)} 0 0 cm ${n2(iw)} 0 0 ${n2(ih)} ${n2(-iw / 2)} ${n2(-ih / 2)} cm /PDFgWm Do\n`;
    } else if (spec.text) {
      const f = fontResource(pdf, res);
      const e = encode(spec.text);
      lossy ||= e.lossy;
      const tw = textWidth(font, spec.text, spec.fontSize);
      const dx = -tw / 2;
      const dy = -spec.fontSize * 0.35;
      const tx = w / 2 + dx * cos - dy * sin;
      const ty = h / 2 + dx * sin + dy * cos;
      content += `BT /${f} ${n2(spec.fontSize)} Tf ${rgb(spec.color)} rg ${n2(cos)} ${n2(sin)} ${n2(-sin)} ${n2(cos)} ${n2(tx)} ${n2(ty)} Tm (${e.s}) Tj ET\n`;
    }
    content += "Q\n";
    addMarkStream(pdf, page, "watermark", content, spec.behind);
  }
  return lossy;
}

export function addBackground(pdf: mupdf.PDFDocument, spec: BackgroundSpec) {
  removeMarks(pdf, "background", spec.pages);
  for (const p of spec.pages) {
    const page = pdf.findPage(p);
    const res = ownResources(pdf, page);
    const gs = alphaResource(pdf, res, spec.opacity);
    const { m, w, h } = viewMatrix(page);
    addMarkStream(pdf, page, "background", `q ${m.map(n2).join(" ")} cm /${gs} gs ${rgb(spec.color)} rg 0 0 ${n2(w)} ${n2(h)} re f Q\n`, true);
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
