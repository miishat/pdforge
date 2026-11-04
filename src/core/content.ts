// Editing page content: text lines, new text, images, links, bookmarks, metadata, attachments.
import * as mupdf from "mupdf";
import { appendContent, encodeWinAnsi, ownResources } from "./stamping";
import type { Color, Point, Rect } from "./types";

export interface TextLine {
  index: number;
  /** Page-space bounding box. */
  rect: Rect;
  text: string;
  font: string;
  size: number;
  color: Color;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** Baseline start, page space. */
  origin: Point;
  editable: boolean;
  /** Why it can't be edited, when it can't. */
  reason: string | null;
}

interface LineData {
  info: TextLine;
  font: mupdf.Font;
  quads: number[][];
}

export interface ImageInfo {
  index: number;
  rect: Rect;
  width: number;
  height: number;
}

/** Text lines and images of a page, with the MuPDF objects needed to edit them. */
export function readPage(page: mupdf.PDFPage): { lines: LineData[]; images: { info: ImageInfo; image: mupdf.Image }[] } {
  const st = page.toStructuredText("preserve-images,preserve-whitespace");
  const lines: LineData[] = [];
  const images: { info: ImageInfo; image: mupdf.Image }[] = [];
  let cur: { chars: string[]; quads: number[][]; font: mupdf.Font | null; size: number; color: number[]; origin: Point | null; dir: Point; bbox: Rect } | null = null;
  st.walk({
    onImageBlock(bbox, _t, image) {
      images.push({ info: { index: images.length, rect: bbox as Rect, width: image.getWidth(), height: image.getHeight() }, image });
    },
    beginLine(bbox, _wmode, dir) {
      cur = { chars: [], quads: [], font: null, size: 0, color: [0, 0, 0], origin: null, dir: dir as Point, bbox: bbox as Rect };
    },
    onChar(c, origin, font, size, quad, color) {
      if (!cur) return;
      if (!cur.font) {
        cur.font = font;
        cur.size = size;
        cur.color = color as number[];
        cur.origin = origin as Point;
      }
      cur.chars.push(c);
      cur.quads.push(quad as number[]);
    },
    endLine() {
      const l = cur;
      cur = null;
      if (!l || !l.font || !l.chars.length) return;
      const text = l.chars.join("");
      if (!text.trim()) return;
      const horizontal = Math.abs(l.dir[1]) < 0.01 && l.dir[0] > 0;
      const font = l.font;
      lines.push({
        font,
        quads: l.quads,
        info: {
          index: lines.length,
          rect: l.bbox,
          text: text.replace(/\s+$/, ""),
          font: font.getName().replace(/^[A-Z]{6}\+/, ""),
          size: Math.round(l.size * 100) / 100,
          color: toRgb(l.color),
          bold: font.isBold(),
          italic: font.isItalic(),
          serif: font.isSerif(),
          mono: font.isMono(),
          origin: l.origin!,
          editable: horizontal,
          reason: horizontal ? null : "Rotated or vertical text can't be edited yet.",
        },
      });
    },
  });
  return { lines, images };
}

function toRgb(c: number[]): Color {
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) return [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}

function assertNoPendingRedactions(page: mupdf.PDFPage) {
  if (page.getAnnotations().some((a) => a.getType() === "Redact"))
    throw new Error("Apply or remove the redaction marks on this page first.");
}

/** Removes content under a page-space area: text, images, or both. */
function erase(page: mupdf.PDFPage, rects: Rect[] | number[][], what: { text: boolean; images: boolean }, asQuads = false) {
  assertNoPendingRedactions(page);
  const a = page.createAnnotation("Redact");
  if (asQuads) a.setQuadPoints(rects as mupdf.Quad[]);
  else a.setRect(rects[0] as Rect);
  a.update();
  page.applyRedactions(
    false,
    what.images ? mupdf.PDFPage.REDACT_IMAGE_REMOVE : mupdf.PDFPage.REDACT_IMAGE_NONE,
    mupdf.PDFPage.REDACT_LINE_ART_NONE,
    what.text ? mupdf.PDFPage.REDACT_TEXT_REMOVE : mupdf.PDFPage.REDACT_TEXT_NONE,
  );
}

const BASE14 = {
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

export type FontFamily = "sans" | "serif" | "mono";

function base14(family: FontFamily, bold: boolean, italic: boolean): string {
  return BASE14[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

/** A text-space → PDF-space matrix for upright text with its baseline at a page-space origin. */
function textMatrix(page: mupdf.PDFPage, origin: Point): mupdf.Matrix {
  const toPdf = mupdf.Matrix.invert(page.getTransform());
  return mupdf.Matrix.concat([1, 0, 0, -1, origin[0], origin[1]], toPdf);
}

/**
 * Writes text into the page content. Uses `font` (e.g. the line's original embedded font) when it has every
 * glyph; otherwise a matching standard font. Returns which font was used and whether it's a substitute.
 */
function writeText(
  pdf: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  text: string,
  origin: Point,
  style: { size: number; color: Color; family: FontFamily; bold: boolean; italic: boolean },
  font?: mupdf.Font,
): { usedFont: string; substituted: boolean; lossy: boolean } {
  const pageObj = page.getObject();
  const res = ownResources(pdf, pageObj);
  let fonts = res.get("Font");
  if (!fonts.isDictionary()) {
    fonts = pdf.newDictionary();
    res.put("Font", fonts);
  }
  const lines = text.split("\n");
  const chars = [...text.replace(/\n/g, "")];
  const usable = font && chars.every((c) => c === " " || font.encodeCharacter(c.codePointAt(0)!) > 0);
  let name: string;
  let show: (line: string) => string;
  let usedFont: string;
  let lossy = false;
  if (usable && font) {
    name = `PDFgE${Object.keys(fontsKeys(fonts)).length}`;
    fonts.put(name, pdf.addFont(font));
    usedFont = font.getName().replace(/^[A-Z]{6}\+/, "");
    show = (line) => `<${[...line].map((c) => font.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, "0")).join("")}> Tj`;
  } else {
    usedFont = base14(style.family, style.bold, style.italic);
    name = `PDFg${usedFont.replace(/-/g, "")}`;
    if (!fonts.get(name).isDictionary())
      fonts.put(name, pdf.addObject({ Type: "Font", Subtype: "Type1", BaseFont: usedFont, Encoding: "WinAnsiEncoding" }));
    show = (line) => {
      const e = encodeWinAnsi(line);
      lossy ||= e.lossy;
      return `(${e.s}) Tj`;
    };
  }
  const m = textMatrix(page, origin);
  let content = `q BT /${name} ${n3(style.size)} Tf ${style.color.map(n3).join(" ")} rg ${n3(style.size * 1.2)} TL ${m.map(n3).join(" ")} Tm\n`;
  lines.forEach((l, i) => (content += `${i ? "T* " : ""}${show(l)}\n`));
  content += "ET Q\n";
  appendContent(pdf, pageObj, content);
  return { usedFont, substituted: !usable, lossy };
}

function fontsKeys(d: mupdf.PDFObject): Record<string, true> {
  const out: Record<string, true> = {};
  d.forEach((_v, k) => (out[String(k)] = true));
  return out;
}

/** Replaces one line of text, keeping its position, size and colour. */
export function replaceLine(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, line: { info: TextLine; font: mupdf.Font; quads: number[][] }, text: string) {
  if (!line.info.editable) throw new Error(line.info.reason ?? "This text can't be edited.");
  erase(page, line.quads, { text: true, images: false }, true);
  if (!text.trim()) return { usedFont: line.info.font, substituted: false, lossy: false };
  const family: FontFamily = line.info.mono ? "mono" : line.info.serif ? "serif" : "sans";
  return writeText(pdf, page, text, line.info.origin, { size: line.info.size, color: line.info.color, family, bold: line.info.bold, italic: line.info.italic }, line.font);
}

export function addText(
  pdf: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  origin: Point,
  text: string,
  style: { size: number; color: Color; family: FontFamily; bold: boolean; italic: boolean },
) {
  return writeText(pdf, page, text, origin, style);
}

function placeImage(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, image: mupdf.Image, rect: Rect) {
  const pageObj = page.getObject();
  const res = ownResources(pdf, pageObj);
  let xo = res.get("XObject");
  if (!xo.isDictionary()) {
    xo = pdf.newDictionary();
    res.put("XObject", xo);
  }
  const name = `PDFgIm${Object.keys(fontsKeys(xo)).length}`;
  xo.put(name, pdf.addImage(image));
  const toPdf = mupdf.Matrix.invert(page.getTransform());
  // Unit square → page-space rect (y down, so flip) → PDF space.
  const m = mupdf.Matrix.concat([rect[2] - rect[0], 0, 0, -(rect[3] - rect[1]), rect[0], rect[3]], toPdf);
  appendContent(pdf, pageObj, `q ${m.map(n3).join(" ")} cm /${name} Do Q\n`);
}

export function deleteImage(page: mupdf.PDFPage, rect: Rect) {
  erase(page, [shrink(rect)], { text: false, images: true });
}

export function moveImage(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, image: mupdf.Image, from: Rect, to: Rect) {
  erase(page, [shrink(from)], { text: false, images: true });
  placeImage(pdf, page, image, to);
}

/** Puts a new image where an old one was, fitted inside the old one's box. */
export function replaceImage(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, rect: Rect, bytes: Uint8Array) {
  erase(page, [shrink(rect)], { text: false, images: true });
  const img = new mupdf.Image(bytes);
  placeImage(pdf, page, img, fit(rect, img.getWidth() / img.getHeight()));
}

export function insertImage(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, rect: Rect, bytes: Uint8Array) {
  const img = new mupdf.Image(bytes);
  placeImage(pdf, page, img, fit(rect, img.getWidth() / img.getHeight()));
}

function fit(r: Rect, aspect: number): Rect {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  if (w / h > aspect) {
    const nw = h * aspect;
    return [r[0] + (w - nw) / 2, r[1], r[0] + (w + nw) / 2, r[3]];
  }
  const nh = w / aspect;
  return [r[0], r[1] + (h - nh) / 2, r[2], r[1] + (h + nh) / 2];
}

/** A slightly smaller box, so erasing one image doesn't catch a neighbour that touches it. */
function shrink([x0, y0, x1, y1]: Rect): Rect {
  const dx = Math.min(1, (x1 - x0) / 4);
  const dy = Math.min(1, (y1 - y0) / 4);
  return [x0 + dx, y0 + dy, x1 - dx, y1 - dy];
}

// ---- Links ----

export function addLink(page: mupdf.PDFPage, rect: Rect, target: { uri: string } | { page: number }) {
  page.createLink(rect, "uri" in target ? target.uri : `#page=${target.page + 1}`);
}

export function deleteLink(page: mupdf.PDFPage, index: number) {
  const link = page.getLinks()[index];
  if (!link) throw new Error("That link no longer exists.");
  page.deleteLink(link);
}

// ---- Bookmarks ----

export interface OutlineEdit {
  title: string;
  page: number;
  children: OutlineEdit[];
}

/** Replaces the whole bookmark tree. */
export function setOutline(pdf: mupdf.PDFDocument, nodes: OutlineEdit[]) {
  const it = pdf.outlineIterator();
  while (it.item()) it.delete();
  const write = (list: OutlineEdit[]) => {
    for (const n of list) {
      it.insert({ title: n.title || "Untitled", uri: `#page=${n.page + 1}`, open: true });
      if (n.children.length) {
        it.prev();
        it.down();
        write(n.children);
        it.up();
        it.next();
      }
    }
  };
  write(nodes);
}

// ---- Metadata and attachments ----

export function setMetadata(pdf: mupdf.PDFDocument, fields: Partial<Record<"Title" | "Author" | "Subject" | "Keywords", string>>) {
  for (const [k, v] of Object.entries(fields)) pdf.setMetaData(`info:${k}`, v ?? "");
}

export function addAttachment(pdf: mupdf.PDFDocument, name: string, mime: string, bytes: Uint8Array) {
  const now = new Date();
  pdf.insertEmbeddedFile(name, pdf.addEmbeddedFile(name, mime, bytes, now, now));
}

export function deleteAttachment(pdf: mupdf.PDFDocument, name: string) {
  pdf.deleteEmbeddedFile(name);
}
