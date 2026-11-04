// Page organisation: reorder, delete, rotate, insert, duplicate, replace, extract, split, merge, crop, resize.
// All operations take 0-based page indices.
import * as mupdf from "mupdf";
import type { Rect } from "./types";

export const PAGE_SIZES: Record<string, [number, number]> = {
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
  A3: [842, 1191],
  A4: [595, 842],
  A5: [420, 595],
};

function count(pdf: mupdf.PDFDocument) {
  return pdf.countPages();
}

/** Moves the given pages so they start at `to` (an index in the document *before* the move). */
export function movePages(pdf: mupdf.PDFDocument, pages: number[], to: number): number[] {
  const n = count(pdf);
  const moving = [...new Set(pages)].filter((p) => p >= 0 && p < n).sort((a, b) => a - b);
  const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !moving.includes(i));
  const insertAt = rest.filter((i) => i < to).length;
  const order = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
  pdf.rearrangePages(order);
  return order;
}

export function deletePages(pdf: mupdf.PDFDocument, pages: number[]) {
  const n = count(pdf);
  const keep = Array.from({ length: n }, (_, i) => i).filter((i) => !pages.includes(i));
  if (!keep.length) throw new Error("A document needs at least one page.");
  pdf.rearrangePages(keep);
}

export function duplicatePages(pdf: mupdf.PDFDocument, pages: number[]) {
  const n = count(pdf);
  const set = new Set(pages);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    order.push(i);
    if (set.has(i)) order.push(i);
  }
  pdf.rearrangePages(order);
  // rearrangePages shares the same page object for duplicates; give each copy its own object.
  separateSharedPages(pdf);
}

function separateSharedPages(pdf: mupdf.PDFDocument) {
  const seen = new Set<number>();
  const n = count(pdf);
  for (let i = 0; i < n; i++) {
    const obj = pdf.findPage(i);
    const num = obj.asIndirect();
    if (!seen.has(num)) {
      seen.add(num);
      continue;
    }
    // Copy the page dictionary (resources and contents are shared, which is fine).
    const copy = pdf.addObject(pdf.newDictionary());
    obj.forEach((v, k) => copy.put(k, v));
    copy.delete("Annots");
    pdf.deletePage(i);
    pdf.insertPage(i, copy);
  }
}

/** Rotates pages by a multiple of 90° (added to their current /Rotate). */
export function rotatePages(pdf: mupdf.PDFDocument, pages: number[], by: number) {
  for (const p of pages) {
    const page = pdf.findPage(p);
    const cur = safe(() => page.getInheritable("Rotate").asNumber(), 0) || 0;
    page.put("Rotate", (((cur + by) % 360) + 360) % 360);
  }
}

export function insertBlank(pdf: mupdf.PDFDocument, at: number, size: [number, number]) {
  const page = pdf.addPage([0, 0, size[0], size[1]], 0, pdf.newDictionary(), "");
  pdf.insertPage(at, page);
}

/** Inserts pages from another PDF (all, or the listed ones) at `at`. Returns how many were inserted. */
export function insertFrom(pdf: mupdf.PDFDocument, at: number, src: mupdf.PDFDocument, pages?: number[]): number {
  const list = pages ?? Array.from({ length: src.countPages() }, (_, i) => i);
  const map = pdf.newGraftMap();
  list.forEach((sp, i) => map.graftPage(at + i, src, sp));
  return list.length;
}

/** A new page holding one image, sized to the image at 150 dpi but at most A4/Letter-ish. */
export function insertImagePage(pdf: mupdf.PDFDocument, at: number, bytes: Uint8Array) {
  const img = new mupdf.Image(bytes);
  let w = (img.getWidth() / 150) * 72;
  let h = (img.getHeight() / 150) * 72;
  const max = 842;
  const s = Math.min(1, max / Math.max(w, h));
  w *= s;
  h *= s;
  const res = pdf.addObject({ XObject: { Im0: pdf.addImage(img) } });
  const page = pdf.addPage([0, 0, w, h], 0, res, `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
  pdf.insertPage(at, page);
}

/** Replaces `pages` with pages from `src` (same count, in order). */
export function replacePages(pdf: mupdf.PDFDocument, pages: number[], src: mupdf.PDFDocument, srcPages: number[]) {
  if (pages.length !== srcPages.length) throw new Error(`Choose ${pages.length} page${pages.length === 1 ? "" : "s"} to replace them with.`);
  const sorted = [...pages].sort((a, b) => a - b);
  const map = pdf.newGraftMap();
  sorted.forEach((p, i) => {
    pdf.deletePage(p);
    map.graftPage(p, src, srcPages[i]);
  });
}

/** A new document containing copies of the given pages, with their bookmarks and attachments left behind. */
export function extractPages(pdf: mupdf.PDFDocument, pages: number[]): Uint8Array {
  const out = new mupdf.PDFDocument();
  const map = out.newGraftMap();
  pages.forEach((p, i) => map.graftPage(i, pdf, p));
  copyInfo(pdf, out);
  return out.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
}

export type SplitPlan = { kind: "every"; n: number } | { kind: "ranges"; ranges: number[][] } | { kind: "bookmarks" };

/** Splits into several documents. Returns each part's bytes and a short label for its file name. */
export function splitDocument(pdf: mupdf.PDFDocument, plan: SplitPlan): { label: string; bytes: Uint8Array }[] {
  const n = count(pdf);
  let groups: { label: string; pages: number[] }[] = [];
  if (plan.kind === "every") {
    for (let i = 0; i < n; i += plan.n) groups.push({ label: `pages ${i + 1}-${Math.min(n, i + plan.n)}`, pages: range(i, Math.min(n, i + plan.n)) });
  } else if (plan.kind === "ranges") {
    groups = plan.ranges.filter((r) => r.length).map((r) => ({ label: r.length === 1 ? `page ${r[0] + 1}` : `pages ${r[0] + 1}-${r[r.length - 1] + 1}`, pages: r }));
  } else {
    const top = (safe(() => pdf.loadOutline(), null) ?? []).filter((o) => typeof o.page === "number" && o.page >= 0);
    if (!top.length) throw new Error("This document has no bookmarks to split by.");
    const starts = [...new Map(top.map((o) => [o.page!, o.title ?? ""])).entries()].sort((a, b) => a[0] - b[0]);
    if (starts[0][0] > 0) starts.unshift([0, "Start"]);
    groups = starts.map(([start, title], i) => ({ label: sanitizeName(title) || `part ${i + 1}`, pages: range(start, starts[i + 1]?.[0] ?? n) }));
  }
  return groups.map((g) => ({ label: g.label, bytes: extractPages(pdf, g.pages) }));
}

/** Combines several PDFs into one, optionally with a top-level bookmark per file. */
export function mergeDocuments(files: { name: string; bytes: Uint8Array; password?: string }[], bookmarks: boolean): Uint8Array {
  const out = new mupdf.PDFDocument();
  const marks: { title: string; page: number }[] = [];
  for (const f of files) {
    const doc = mupdf.Document.openDocument(f.bytes, "application/pdf");
    if (doc.needsPassword() && !(f.password && doc.authenticatePassword(f.password))) throw new Error(`${f.name} is password-protected.`);
    const src = doc.asPDF();
    if (!src) throw new Error(`${f.name} isn't a PDF.`);
    const at = out.countPages();
    marks.push({ title: f.name.replace(/\.pdf$/i, ""), page: at });
    const map = out.newGraftMap();
    for (let i = 0; i < src.countPages(); i++) map.graftPage(at + i, src, i);
  }
  if (bookmarks) {
    const it = out.outlineIterator();
    for (const m of marks) it.insert({ title: m.title, uri: `#page=${m.page + 1}`, open: false });
  }
  out.setMetaData("info:Producer", "PDForge");
  return out.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
}

/** Sets the visible area (CropBox) of pages. `margins` trims each side, in points, from the current crop. */
export function cropPages(pdf: mupdf.PDFDocument, pages: number[], margins: { top: number; right: number; bottom: number; left: number }) {
  for (const p of pages) {
    const page = pdf.loadPage(p);
    const box = pdfBox(page, "CropBox");
    const r: Rect = [box[0] + margins.left, box[1] + margins.bottom, box[2] - margins.right, box[3] - margins.top];
    if (r[2] - r[0] < 18 || r[3] - r[1] < 18) throw new Error("Those margins would leave almost nothing of the page.");
    setPdfBox(page, "CropBox", r);
  }
}

/** Crops pages to their content (text, images and drawings) plus `pad` points. */
export function cropToContent(pdf: mupdf.PDFDocument, pages: number[], pad = 18) {
  for (const p of pages) {
    const page = pdf.loadPage(p);
    const bbox = contentBounds(page);
    if (!bbox) continue;
    // Content bounds are in page (fitz) space; convert to PDF space for the box.
    const toPdf = mupdf.Matrix.invert(page.getTransform());
    const r = mupdf.Rect.transform([bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad], toPdf);
    const media = pdfBox(page, "MediaBox");
    setPdfBox(page, "CropBox", [
      Math.max(media[0], Math.min(r[0], r[2])),
      Math.max(media[1], Math.min(r[1], r[3])),
      Math.min(media[2], Math.max(r[0], r[2])),
      Math.min(media[3], Math.max(r[1], r[3])),
    ]);
  }
}

/** Bounds of everything drawn on the page (text, images, vector art), ignoring white-only fills. */
export function contentBounds(page: mupdf.PDFPage): Rect | null {
  let r: Rect | null = null;
  const grow = (b: number[]) => {
    if (!(b[2] > b[0] && b[3] > b[1]) || !b.every(Number.isFinite)) return;
    r = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])] : [b[0], b[1], b[2], b[3]];
  };
  const white = (color: number[], cs: mupdf.ColorSpace) => {
    const n = cs.getNumberOfComponents();
    if (n === 1) return color[0] >= 0.99;
    if (n === 3) return color.every((c) => c >= 0.99);
    if (n === 4) return color.every((c) => c <= 0.01);
    return false;
  };
  const unit = (ctm: mupdf.Matrix) => mupdf.Rect.transform([0, 0, 1, 1], ctm);
  const thin = new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 });
  const device = new mupdf.Device({
    fillPath: (path, _eo, ctm, cs, color) => !white(color, cs) && grow(path.getBounds(thin, ctm)),
    strokePath: (path, stroke, ctm) => grow(path.getBounds(stroke, ctm)),
    fillText: (text, ctm) => grow(text.getBounds(thin, ctm)),
    strokeText: (text, stroke, ctm) => grow(text.getBounds(stroke, ctm)),
    fillImage: (_img, ctm) => grow(unit(ctm)),
    fillImageMask: (_img, ctm) => grow(unit(ctm)),
    fillShade: (shade, ctm) => grow(mupdf.Rect.transform(shade.getBounds(), ctm)),
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  return r;
}

/** Changes the paper size, scaling and centring the content to fit. */
export function resizePages(pdf: mupdf.PDFDocument, pages: number[], size: [number, number], scaleContent: boolean) {
  for (const p of pages) {
    const page = pdf.loadPage(p);
    const pageObj = page.getObject();
    const crop = pdfBox(page, "CropBox");
    const rot = safe(() => pageObj.getInheritable("Rotate").asNumber(), 0) || 0;
    // Target size in unrotated page orientation.
    let [tw, th] = size;
    if (rot % 180 !== 0) [tw, th] = [th, tw];
    const cw = crop[2] - crop[0];
    const ch = crop[3] - crop[1];
    const s = scaleContent ? Math.min(tw / cw, th / ch) : 1;
    const tx = (tw - cw * s) / 2 - crop[0] * s;
    const ty = (th - ch * s) / 2 - crop[1] * s;
    wrapContents(pdf, pageObj, `q ${num(s)} 0 0 ${num(s)} ${num(tx)} ${num(ty)} cm\n`, "\nQ");
    pageObj.put("MediaBox", [0, 0, tw, th]);
    pageObj.delete("CropBox");
    pageObj.delete("TrimBox");
    pageObj.delete("BleedBox");
    pageObj.delete("ArtBox");
    // Move annotations with the content.
    const annots = pageObj.get("Annots");
    if (annots.isArray())
      for (let i = 0; i < annots.length; i++) {
        const a = annots.get(i);
        const rect = a.get("Rect");
        if (rect.isArray() && rect.length === 4) {
          const v = [0, 1, 2, 3].map((k) => rect.get(k).asNumber());
          a.put("Rect", [v[0] * s + tx, v[1] * s + ty, v[2] * s + tx, v[3] * s + ty]);
        }
      }
  }
}

/** Surrounds a page's content with extra operators (used for scaling); keeps the original streams intact. */
export function wrapContents(pdf: mupdf.PDFDocument, pageObj: mupdf.PDFObject, before: string, after: string) {
  const contents = pageObj.get("Contents");
  const list = pdf.newArray();
  list.push(pdf.addStream(before, {}));
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) list.push(contents.get(i));
  else if (!contents.isNull()) list.push(contents);
  list.push(pdf.addStream(after, {}));
  pageObj.put("Contents", list);
}

export function pdfBox(page: mupdf.PDFPage, which: "MediaBox" | "CropBox"): Rect {
  const obj = page.getObject();
  let box = safe(() => obj.getInheritable(which), null);
  if ((!box || !box.isArray()) && which === "CropBox") box = obj.getInheritable("MediaBox");
  const v = [0, 1, 2, 3].map((i) => box!.get(i).asNumber());
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

function setPdfBox(page: mupdf.PDFPage, which: "CropBox", r: Rect) {
  page.getObject().put(which, r.map((v) => Math.round(v * 100) / 100));
}

function copyInfo(from: mupdf.PDFDocument, to: mupdf.PDFDocument) {
  for (const k of ["Title", "Author", "Subject", "Keywords"]) {
    const v = safe(() => from.getMetaData(`info:${k}`), undefined);
    if (v) to.setMetaData(`info:${k}`, v);
  }
}

function range(a: number, b: number) {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}

function sanitizeName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

function num(n: number) {
  return String(Math.round(n * 10000) / 10000);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
