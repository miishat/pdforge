// Redaction (permanent removal of content) and sanitising (removing hidden data).
import * as mupdf from "mupdf";
import type { Quad, Rect } from "./types";

export interface RedactionPreset {
  id: string;
  label: string;
  pattern: string;
  /** Extra check on each match (e.g. the Luhn checksum for card numbers). */
  validate?: (match: string) => boolean;
}

export function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let v = Number(d[d.length - 1 - i]);
    if (i % 2) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

export const PRESETS: RedactionPreset[] = [
  { id: "email", label: "Email addresses", pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}" },
  { id: "phone", label: "Phone numbers", pattern: "(?<![\\w]|\\d[\\s.-])(?:\\+\\d{1,3}[\\s.-]?)?(?:\\(\\d{2,4}\\)[\\s.-]?|\\d{2,4}[\\s.-])\\d{3,4}[\\s.-]?\\d{3,4}(?![\\w]|[\\s.-]\\d)" },
  { id: "ssn", label: "US Social Security numbers", pattern: "(?<!\\d)\\d{3}-\\d{2}-\\d{4}(?!\\d)" },
  { id: "card", label: "Credit card numbers", pattern: "(?<!\\d)(?:\\d[ -]?){12,18}\\d(?!\\d)", validate: luhn },
  { id: "iban", label: "IBAN bank accounts", pattern: "\\b[A-Z]{2}\\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\\b" },
  { id: "date", label: "Dates", pattern: "\\b(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})\\b" },
  { id: "ip", label: "IP addresses", pattern: "\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b" },
];

/** Adds redaction marks (not yet applied). Text marks use quads; area marks use rects. */
export function markForRedaction(page: mupdf.PDFPage, marks: { quads?: Quad[]; rect?: Rect }[], overlayText?: string): number {
  let n = 0;
  for (const m of marks) {
    const a = page.createAnnotation("Redact");
    if (m.quads?.length) a.setQuadPoints(m.quads as mupdf.Quad[]);
    else if (m.rect) a.setRect(m.rect);
    else continue;
    if (overlayText) a.getObject().put("OverlayText", overlayText);
    a.setModificationDate(new Date());
    a.update();
    n++;
  }
  return n;
}

export function countRedactionMarks(pdf: mupdf.PDFDocument): number {
  let n = 0;
  for (let p = 0; p < pdf.countPages(); p++) {
    const page = pdf.loadPage(p);
    n += page.getAnnotations().filter((a) => a.getType() === "Redact").length;
    page.destroy();
  }
  return n;
}

export interface ApplyOptions {
  /** What happens to images under a mark: blank out the covered pixels, remove the whole image, or keep it. */
  images: "pixels" | "remove" | "keep";
  /** Remove vector drawings that are fully covered. */
  lineArt: boolean;
  /** Draw a black box where content was removed. */
  blackBoxes: boolean;
}

/** Permanently removes everything under the redaction marks. Returns the pages that changed. */
export function applyRedactions(pdf: mupdf.PDFDocument, opts: ApplyOptions): number[] {
  const pages: number[] = [];
  const image = opts.images === "pixels" ? mupdf.PDFPage.REDACT_IMAGE_PIXELS : opts.images === "remove" ? mupdf.PDFPage.REDACT_IMAGE_REMOVE : mupdf.PDFPage.REDACT_IMAGE_NONE;
  const line = opts.lineArt ? mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED : mupdf.PDFPage.REDACT_LINE_ART_NONE;
  for (let p = 0; p < pdf.countPages(); p++) {
    const page = pdf.loadPage(p);
    if (page.getAnnotations().some((a) => a.getType() === "Redact")) {
      page.applyRedactions(opts.blackBoxes, image, line, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      pages.push(p);
    }
    page.destroy();
  }
  return pages;
}

export interface SanitizeOptions {
  metadata: boolean;
  javascript: boolean;
  attachments: boolean;
  comments: boolean;
  thumbnails: boolean;
  privateData: boolean;
}

export interface SanitizeReport {
  metadata: number;
  javascript: number;
  attachments: number;
  comments: number;
  thumbnails: number;
  privateData: number;
}

/** Removes hidden or non-visible data. Counts what was removed in each category. */
export function sanitize(pdf: mupdf.PDFDocument, o: SanitizeOptions): SanitizeReport {
  const r: SanitizeReport = { metadata: 0, javascript: 0, attachments: 0, comments: 0, thumbnails: 0, privateData: 0 };
  const trailer = pdf.getTrailer();
  const root = trailer.get("Root");
  const del = (dict: mupdf.PDFObject, key: string, counter: keyof SanitizeReport) => {
    if (dict.isDictionary() && !dict.get(key).isNull()) {
      dict.delete(key);
      r[counter]++;
    }
  };

  if (o.metadata) {
    const info = trailer.get("Info");
    if (info.isDictionary()) {
      const keys: string[] = [];
      info.forEach((_v, k) => keys.push(String(k)));
      for (const k of keys) {
        info.delete(k);
        r.metadata++;
      }
    }
    del(root, "Metadata", "metadata");
  }
  if (o.javascript) {
    const names = root.get("Names");
    del(names, "JavaScript", "javascript");
    const oa = root.get("OpenAction");
    if (oa.isDictionary() && isScript(oa)) del(root, "OpenAction", "javascript");
    del(root, "AA", "javascript");
    const acro = root.get("AcroForm");
    if (acro.isDictionary()) del(acro, "XFA", "javascript");
  }
  if (o.attachments) {
    const names = root.get("Names");
    del(names, "EmbeddedFiles", "attachments");
  }

  for (let p = 0; p < pdf.countPages(); p++) {
    const page = pdf.loadPage(p);
    const obj = page.getObject();
    if (o.metadata) del(obj, "Metadata", "metadata");
    if (o.privateData) del(obj, "PieceInfo", "privateData");
    if (o.thumbnails) del(obj, "Thumb", "thumbnails");
    if (o.javascript) del(obj, "AA", "javascript");
    for (const a of page.getAnnotations()) {
      const type = a.getType();
      const ao = a.getObject();
      if (o.javascript) {
        const act = ao.get("A");
        if (act.isDictionary() && isScript(act)) del(ao, "A", "javascript");
        del(ao, "AA", "javascript");
      }
      if ((o.attachments && type === "FileAttachment") || (o.comments && type !== "Link" && type !== "Widget")) {
        if (type === "FileAttachment") r.attachments++;
        else r.comments++;
        page.deleteAnnotation(a);
      }
    }
    if (o.javascript)
      for (const w of page.getWidgets()) {
        const wo = w.getObject();
        del(wo, "AA", "javascript");
        const act = wo.get("A");
        if (act.isDictionary() && isScript(act)) del(wo, "A", "javascript");
      }
    page.destroy();
  }
  if (o.privateData) del(root, "PieceInfo", "privateData");
  return r;
}

function isScript(action: mupdf.PDFObject): boolean {
  try {
    const s = action.get("S");
    return s.isName() && (s.asName() === "JavaScript" || s.asName() === "Launch");
  } catch {
    return false;
  }
}
