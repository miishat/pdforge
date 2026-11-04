// PDF engine: a thin, DOM-free layer over MuPDF. Runs in a Web Worker in the app
// and directly in Node for tests (and, later, the CLI).
import * as mupdf from "mupdf";
import { buildPattern, searchLayer } from "./textlayer";
import type {
  AnnotationInfo,
  AttachmentInfo,
  DocInfo,
  DocProperties,
  FontInfo,
  LayerInfo,
  LinkInfo,
  OpenResult,
  OutlineNode,
  Permission,
  Rect,
  RenderedPage,
  RenderRequest,
  SearchHit,
  SearchOptions,
  TextLayer,
  ViewRotation,
} from "./types";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: "not-found" | "bad-password" | "invalid-file" | "bad-page" | "bad-query" | "no-attachment",
  ) {
    super(message);
  }
}

type OutlineItems = NonNullable<ReturnType<mupdf.Document["loadOutline"]>>;

const PERMISSIONS: Permission[] = ["print", "copy", "edit", "annotate", "form", "accessibility", "assemble", "print-hq"];
const TEXT_CACHE_PAGES = 64;
const SKIPPED_ANNOTS = new Set(["Link", "Widget", "Popup"]);

interface OpenDoc {
  doc: mupdf.Document;
  /** Text layers by page, in least-recently-used order. */
  text: Map<number, TextLayer>;
}

export class PdfEngine {
  private docs = new Map<number, OpenDoc>();
  private nextId = 1;

  open(bytes: Uint8Array): OpenResult {
    let doc: mupdf.Document;
    try {
      doc = mupdf.Document.openDocument(bytes, "application/pdf");
    } catch (err) {
      throw new EngineError(`This file couldn't be opened as a PDF (${errText(err)}).`, "invalid-file");
    }
    const docId = this.nextId++;
    this.docs.set(docId, { doc, text: new Map() });
    if (doc.needsPassword()) return { status: "needs-password", docId };
    return { status: "ok", info: this.info(docId) };
  }

  /** Returns document info if the password is right; throws `bad-password` otherwise. */
  unlock(docId: number, password: string): DocInfo {
    const { doc } = this.get(docId);
    if (!doc.authenticatePassword(password)) {
      throw new EngineError("That password isn't right.", "bad-password");
    }
    return this.info(docId);
  }

  info(docId: number): DocInfo {
    const { doc } = this.get(docId);
    const pageCount = doc.countPages();
    const pages = [];
    const labels: string[] = [];
    let hasLabels = false;
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      pages.push({ width: x1 - x0, height: y1 - y0 });
      const label = safe(() => page.getLabel(), "") || String(i + 1);
      if (label !== String(i + 1)) hasLabels = true;
      labels.push(label);
      page.destroy();
    }
    const meta = (key: string) => doc.getMetaData(key)?.trim() || null;
    return {
      docId,
      pageCount,
      pages,
      title: meta("info:Title"),
      author: meta("info:Author"),
      format: meta("format"),
      labels: hasLabels ? labels : null,
      permissions: this.permissions(doc),
    };
  }

  /** Renders a page (or a region of it) to RGBA pixels. */
  render(req: RenderRequest): RenderedPage {
    const pix = this.pixmap(req);
    try {
      return { width: pix.getWidth(), height: pix.getHeight(), pixels: rgbToRgba(pix) };
    } finally {
      pix.destroy();
    }
  }

  /** Renders to an encoded image (PNG, or JPEG for print jobs where size matters). */
  renderImage(req: RenderRequest, format: "png" | "jpeg" = "png"): Uint8Array {
    const pix = this.pixmap(req);
    try {
      return format === "png" ? pix.asPNG() : pix.asJPEG(90);
    } finally {
      pix.destroy();
    }
  }

  textLayer(docId: number, pageIndex: number): TextLayer {
    const entry = this.get(docId);
    const cached = entry.text.get(pageIndex);
    if (cached) {
      entry.text.delete(pageIndex);
      entry.text.set(pageIndex, cached);
      return cached;
    }
    const page = this.page(entry.doc, pageIndex);
    const stext = page.toStructuredText("preserve-whitespace,dehyphenate");
    const chars: string[] = [];
    const quads: number[] = [];
    const lines: number[] = [];
    let line = -1;
    let lastQuad: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
    stext.walk({
      beginLine() {
        if (line >= 0) {
          // Synthetic line break with a zero-width quad at the end of the previous line.
          chars.push("\n");
          const [, , urx, ury, , , lrx, lry] = lastQuad;
          quads.push(urx, ury, urx, ury, lrx, lry, lrx, lry);
          lines.push(line);
        }
        line++;
      },
      onChar(c, _origin, _font, _size, quad) {
        chars.push(c);
        quads.push(...quad);
        lines.push(line);
        lastQuad = quad;
      },
    });
    stext.destroy();
    page.destroy();
    const layer: TextLayer = { text: chars.join(""), quads: new Float32Array(quads), lines: new Int32Array(lines) };
    entry.text.set(pageIndex, layer);
    if (entry.text.size > TEXT_CACHE_PAGES) entry.text.delete(entry.text.keys().next().value!);
    return layer;
  }

  pageText(docId: number, pageIndex: number): string {
    return this.textLayer(docId, pageIndex).text;
  }

  /** Searches pages [from, to). Call repeatedly in batches so the UI can show progress and cancel. */
  search(docId: number, query: string, opts: SearchOptions, from: number, to: number, limit = 5000): SearchHit[] {
    const { doc } = this.get(docId);
    const pattern = buildPattern(query, opts);
    if (!pattern) throw new EngineError("That search pattern isn't valid.", "bad-query");
    const hits: SearchHit[] = [];
    const end = Math.min(to, doc.countPages());
    for (let p = Math.max(0, from); p < end && hits.length < limit; p++) {
      hits.push(...searchLayer(this.textLayer(docId, p), p, pattern, limit - hits.length));
    }
    return hits;
  }

  links(docId: number, pageIndex: number): LinkInfo[] {
    const { doc } = this.get(docId);
    const page = this.page(doc, pageIndex);
    try {
      return page.getLinks().map((link) => {
        const rect = link.getBounds() as Rect;
        if (link.isExternal()) return { rect, uri: link.getURI(), dest: null };
        return { rect, uri: null, dest: this.resolve(doc, link) };
      });
    } finally {
      page.destroy();
    }
  }

  outline(docId: number): OutlineNode[] {
    const { doc } = this.get(docId);
    const convert = (items: OutlineItems | undefined): OutlineNode[] =>
      (items ?? []).map((item) => {
        const external = item.uri && !item.uri.startsWith("#") ? item.uri : null;
        let dest: OutlineNode["dest"] = null;
        if (!external && item.uri) dest = this.resolve(doc, item.uri);
        else if (!external && typeof item.page === "number" && item.page >= 0) dest = { page: item.page, y: null };
        return { title: item.title?.trim() || "Untitled", dest, uri: external, open: item.open, children: convert(item.down) };
      });
    return convert(safe(() => doc.loadOutline() ?? undefined, undefined));
  }

  attachments(docId: number): AttachmentInfo[] {
    const pdf = this.pdf(docId);
    if (!pdf) return [];
    const files = safe(() => pdf.getEmbeddedFiles(), {});
    return Object.entries(files).map(([name, ref]) => {
      const params = safe(() => pdf.getFilespecParams(ref), null);
      return {
        name: params?.filename || name,
        size: params && params.size >= 0 ? params.size : null,
        mimeType: params?.mimetype || null,
        modified: params?.modificationDate ? new Date(params.modificationDate).toISOString() : null,
      };
    });
  }

  attachment(docId: number, name: string): Uint8Array {
    const pdf = this.pdf(docId);
    const files = pdf ? safe(() => pdf.getEmbeddedFiles(), {}) : {};
    for (const [key, ref] of Object.entries(files)) {
      const params = safe(() => pdf!.getFilespecParams(ref), null);
      if (key === name || params?.filename === name) {
        const buf = pdf!.getEmbeddedFileContents(ref);
        if (buf) return buf.asUint8Array().slice();
      }
    }
    throw new EngineError(`The attachment "${name}" couldn't be found.`, "no-attachment");
  }

  layers(docId: number): LayerInfo[] {
    const pdf = this.pdf(docId);
    if (!pdf) return [];
    const n = safe(() => pdf.countLayers(), 0);
    return Array.from({ length: n }, (_, index) => ({
      index,
      name: safe(() => pdf.getLayerName(index), "") || `Layer ${index + 1}`,
      visible: safe(() => pdf.isLayerVisible(index), true),
    }));
  }

  setLayerVisible(docId: number, index: number, visible: boolean): void {
    this.pdf(docId)?.setLayerVisible(index, visible);
  }

  annotations(docId: number): AnnotationInfo[] {
    const pdf = this.pdf(docId);
    if (!pdf) return [];
    const out: AnnotationInfo[] = [];
    const n = pdf.countPages();
    for (let p = 0; p < n; p++) {
      const page = pdf.loadPage(p);
      for (const a of safe(() => page.getAnnotations(), [])) {
        const type = safe(() => a.getType(), "Unknown");
        if (SKIPPED_ANNOTS.has(type)) continue;
        out.push({
          page: p,
          type,
          contents: safe(() => a.getContents(), ""),
          author: safe(() => a.getAuthor(), ""),
          modified: safe(() => validDate(a.getModificationDate()), null),
          rect: safe(() => a.getBounds() as Rect, [0, 0, 0, 0] as Rect),
        });
      }
      page.destroy();
    }
    return out;
  }

  properties(docId: number): DocProperties {
    const { doc } = this.get(docId);
    const keys = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"];
    const metadata: Record<string, string> = {};
    for (const k of keys) {
      const v = doc.getMetaData(`info:${k}`)?.trim();
      if (v) metadata[k] = /Date$/.test(k) ? formatPdfDate(v) : v;
    }
    const pdf = this.pdf(docId);
    const { fonts, truncated } = pdf ? collectFonts(pdf) : { fonts: [], truncated: false };
    const first = doc.countPages() > 0 ? doc.loadPage(0) : null;
    const b = first?.getBounds();
    first?.destroy();
    return {
      metadata,
      format: doc.getMetaData("format") || null,
      encryption: doc.getMetaData("encryption") || null,
      language: safe(() => pdf?.getLanguage() ?? null, null),
      pageCount: doc.countPages(),
      firstPageSize: b ? { width: b[2] - b[0], height: b[3] - b[1] } : null,
      fonts,
      fontsTruncated: truncated,
      permissions: this.permissions(doc),
      repaired: safe(() => pdf?.wasRepaired() ?? false, false),
    };
  }

  close(docId: number): void {
    const entry = this.docs.get(docId);
    if (entry) {
      entry.doc.destroy();
      this.docs.delete(docId);
    }
  }

  private pixmap({ docId, pageIndex, scale, rotation, region }: RenderRequest): mupdf.Pixmap {
    const { doc } = this.get(docId);
    const page = this.page(doc, pageIndex);
    try {
      const m = renderMatrix(scale, rotation);
      if (!region) return page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true);
      // Only draw the requested window of the page: used for sharp detail at high zoom and snapshots.
      const full = mupdf.Rect.transform(page.getBounds(), m);
      const ox = Math.floor(full[0]);
      const oy = Math.floor(full[1]);
      const bbox: Rect = [ox + Math.floor(region[0]), oy + Math.floor(region[1]), ox + Math.ceil(region[2]), oy + Math.ceil(region[3])];
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
      pix.clear(255);
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
      page.run(device, m);
      device.close();
      device.destroy();
      return pix;
    } finally {
      page.destroy();
    }
  }

  private resolve(doc: mupdf.Document, link: string | mupdf.Link): { page: number; y: number | null } | null {
    const dest = safe(() => doc.resolveLinkDestination(link), null);
    if (!dest || dest.page < 0) return null;
    const hasY = ["XYZ", "FitH", "FitBH", "FitR"].includes(dest.type) && Number.isFinite(dest.y) && !Number.isNaN(dest.y);
    return { page: dest.page, y: hasY ? dest.y : null };
  }

  private permissions(doc: mupdf.Document): Record<Permission, boolean> {
    return Object.fromEntries(PERMISSIONS.map((p) => [p, safe(() => doc.hasPermission(p), true)])) as Record<Permission, boolean>;
  }

  private page(doc: mupdf.Document, index: number): mupdf.Page {
    if (index < 0 || index >= doc.countPages()) throw new EngineError(`Page ${index + 1} doesn't exist.`, "bad-page");
    return doc.loadPage(index);
  }

  private pdf(docId: number): mupdf.PDFDocument | null {
    return this.get(docId).doc.asPDF();
  }

  private get(docId: number): OpenDoc {
    const entry = this.docs.get(docId);
    if (!entry) throw new EngineError("That document is no longer open.", "not-found");
    return entry;
  }
}

export function renderMatrix(scale: number, rotation: ViewRotation): mupdf.Matrix {
  return mupdf.Matrix.concat(mupdf.Matrix.scale(scale, scale), mupdf.Matrix.rotate(rotation));
}

function rgbToRgba(pix: mupdf.Pixmap): Uint8ClampedArray {
  const width = pix.getWidth();
  const height = pix.getHeight();
  const stride = pix.getStride();
  const rgb = pix.getPixels();
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    let src = y * stride;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      rgba[dst] = rgb[src];
      rgba[dst + 1] = rgb[src + 1];
      rgba[dst + 2] = rgb[src + 2];
      rgba[dst + 3] = 255;
      src += 3;
      dst += 4;
    }
  }
  return rgba;
}

const MAX_FONT_PAGES = 500;

function collectFonts(pdf: mupdf.PDFDocument): { fonts: FontInfo[]; truncated: boolean } {
  const seen = new Map<string, FontInfo>();
  const n = pdf.countPages();
  const limit = Math.min(n, MAX_FONT_PAGES);
  for (let p = 0; p < limit; p++) {
    const page = pdf.loadPage(p);
    safe(() => {
      const fonts = page.getObject().getInheritable("Resources").get("Font");
      if (!fonts.isDictionary()) return;
      fonts.forEach((value) => {
        const f = value.resolve();
        let name = safe(() => f.get("BaseFont").asName(), "") || "Unnamed font";
        name = name.replace(/^[A-Z]{6}\+/, ""); // drop subset prefix
        const type = safe(() => f.get("Subtype").asName(), "Unknown");
        let desc = f.get("FontDescriptor");
        if (!desc.isDictionary() && type === "Type0") desc = f.get("DescendantFonts").get(0).get("FontDescriptor");
        const embedded =
          type === "Type3" ||
          (desc.isDictionary() && ["FontFile", "FontFile2", "FontFile3"].some((k) => desc.get(k).isStream()));
        const key = `${name}|${type}|${embedded}`;
        if (!seen.has(key)) seen.set(key, { name, type, embedded });
      });
    }, undefined);
    page.destroy();
  }
  const fonts = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { fonts, truncated: n > limit };
}

/** "D:20240131120000+01'00'" → "2024-01-31 12:00". Returns the input when it isn't a PDF date. */
export function formatPdfDate(v: string): string {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(v);
  if (!m) return v;
  const [, y, mo = "01", d = "01", h, mi] = m;
  return h ? `${y}-${mo}-${d} ${h}:${mi ?? "00"}` : `${y}-${mo}-${d}`;
}

/** Annotations without a date come back as the Unix epoch; treat anything before 1990 as unknown. */
function validDate(d: Date): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1990 ? d.toISOString() : null;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
