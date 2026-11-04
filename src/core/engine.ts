// PDF engine: a thin, DOM-free layer over MuPDF. Runs in a Web Worker in the app
// and directly in Node for tests (and, later, the CLI).
import * as mupdf from "mupdf";
import { addReply, createAnnotation, deleteWithReplies, exportItems, findAnnotation, importItems, listAnnotations, patchAnnotation } from "./editing";
import { fromXfdf, toXfdf } from "./xfdf";
import {
  cropPages, cropToContent, deletePages, duplicatePages, extractPages, insertBlank, insertFrom, insertImagePage,
  mergeDocuments, movePages, replacePages, resizePages, rotatePages, splitDocument, type SplitPlan,
} from "./pages";
import {
  addBackground, addHeaderFooter, addWatermark, markKinds, removeMarks,
  type BackgroundSpec, type HeaderFooterSpec, type MarkKind, type WatermarkSpec,
} from "./stamping";
import { applyRedactions, countRedactionMarks, markForRedaction, PRESETS, sanitize, type ApplyOptions, type SanitizeOptions, type SanitizeReport } from "./redact";
import {
  addAttachment, addLink, addText, deleteAttachment, deleteImage, deleteLink, insertImage, moveImage, readPage,
  replaceImage, replaceLine, setMetadata, setOutline, type FontFamily, type ImageInfo, type OutlineEdit, type TextLine,
} from "./content";
import { pageWidgets, resetForm, setFieldValue, summarize, type FormSummary, type WidgetInfo } from "./forms";
import { openIdentity, signDocument, verifySignatures, type Identity, type SignatureInfo, type SignOptions } from "./signing";
import { buildPattern, searchLayer } from "./textlayer";
import type {
  AnnotationInfo,
  AnnotationPatch,
  EditResult,
  EditState,
  NewAnnotation,
  Quad,
  Point,
  Color,
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
    readonly code: "not-found" | "bad-password" | "invalid-file" | "bad-page" | "bad-query" | "no-attachment" | "edit-failed" | "sign-failed",
  ) {
    super(message);
  }
}

type OutlineItems = NonNullable<ReturnType<mupdf.Document["loadOutline"]>>;

const PERMISSIONS: Permission[] = ["print", "copy", "edit", "annotate", "form", "accessibility", "assemble", "print-hq"];
const TEXT_CACHE_PAGES = 64;

const ANNOT_LABELS: Record<string, string> = {
  Highlight: "highlight", Underline: "underline", StrikeOut: "strikethrough", Squiggly: "squiggly underline",
  Text: "note", FreeText: "text box", Square: "rectangle", Circle: "ellipse", Line: "line", Polygon: "polygon",
  PolyLine: "polyline", Ink: "drawing", Stamp: "stamp",
};

function labelFor(type: string, verb: string): string {
  return `${verb} ${ANNOT_LABELS[type] ?? "comment"}`;
}

interface OpenDoc {
  doc: mupdf.Document;
  /** Text layers by page, in least-recently-used order. */
  text: Map<number, TextLayer>;
  /** The file as it is on disk (needed for signatures, which cover exact bytes). */
  bytes: Uint8Array;
  /** Set by operations that can't be undone (e.g. flattening), so the tab still shows unsaved changes. */
  dirtyOutsideJournal?: boolean;
  /**
   * After redaction or sanitising, an incremental save would keep the removed content in the file's
   * earlier revision, so the next save must rewrite the whole file.
   */
  requireFullSave?: boolean;
  /** Journal position at the last save; the document is dirty when the position differs. */
  savedPosition: number;
}

export class PdfEngine {
  private docs = new Map<number, OpenDoc>();
  private nextId = 1;
  private identities = new Map<number, Identity>();
  private nextIdentity = 1;

  open(bytes: Uint8Array): OpenResult {
    let doc: mupdf.Document;
    try {
      doc = mupdf.Document.openDocument(bytes, "application/pdf");
    } catch (err) {
      throw new EngineError(`This file couldn't be opened as a PDF (${errText(err)}).`, "invalid-file");
    }
    const docId = this.nextId++;
    const pdf = doc.asPDF();
    // Every change goes through the journal so it can be undone.
    if (pdf) safe(() => pdf.enableJournal(), undefined);
    this.docs.set(docId, { doc, text: new Map(), bytes: bytes.slice(), savedPosition: 0 });
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

  /** Annotations on the given pages (all pages when omitted), excluding links, widgets and popups. */
  annotations(docId: number, pages?: number[]): AnnotationInfo[] {
    const pdf = this.pdf(docId);
    return pdf ? listAnnotations(pdf, pages) : [];
  }

  createAnnotation(docId: number, pageIndex: number, spec: NewAnnotation): EditResult {
    return this.edit(docId, labelFor(spec.type, "Add"), (pdf) => {
      const page = this.pdfPage(pdf, pageIndex);
      const a = createAnnotation(pdf, page, spec);
      return { pages: [pageIndex], id: a.getObject().asIndirect() };
    });
  }

  updateAnnotation(docId: number, pageIndex: number, id: number, patch: AnnotationPatch): EditResult {
    const label = patch.translate || patch.rect ? "Move" : "Change";
    return this.edit(docId, `${label} comment`, (pdf) => {
      const page = this.pdfPage(pdf, pageIndex);
      patchAnnotation(findAnnotation(page, id), patch);
      return { pages: [pageIndex], id };
    });
  }

  deleteAnnotation(docId: number, pageIndex: number, id: number): EditResult {
    return this.edit(docId, "Delete comment", (pdf) => {
      const page = this.pdfPage(pdf, pageIndex);
      deleteWithReplies(page, findAnnotation(page, id));
      return { pages: [pageIndex] };
    });
  }

  /** Adds a reply, or with `state` a review status (Accepted, Rejected, Cancelled, Completed, None). */
  replyToAnnotation(docId: number, pageIndex: number, id: number, text: string, author: string, state?: string): EditResult {
    return this.edit(docId, state ? "Set status" : "Reply", (pdf) => {
      const page = this.pdfPage(pdf, pageIndex);
      const r = addReply(pdf, page, findAnnotation(page, id), text, author, state);
      return { pages: [pageIndex], id: r.getObject().asIndirect() };
    });
  }

  widgets(docId: number, pageIndex: number): WidgetInfo[] {
    const pdf = this.pdf(docId);
    return pdf ? pageWidgets(pdf, pageIndex) : [];
  }

  formSummary(docId: number): FormSummary {
    const pdf = this.pdf(docId);
    return pdf ? summarize(pdf) : { fieldCount: 0, hasXfa: false, unsupportedScripts: 0 };
  }

  setFieldValue(docId: number, pageIndex: number, id: number, value: string): EditResult {
    return this.edit(docId, "Fill in form", (pdf) => ({ pages: [...new Set(setFieldValue(pdf, pageIndex, id, value))] }));
  }

  resetForm(docId: number): EditResult {
    return this.edit(docId, "Clear form", (pdf) => {
      resetForm(pdf);
      return { pages: null };
    });
  }

  /** Burns comments and/or form fields into the page content, so they can no longer be changed. */
  flatten(docId: number, what: { annotations: boolean; fields: boolean }): EditResult {
    const entry = this.get(docId);
    const pdf = this.requirePdf(docId);
    pdf.beginOperation("Flatten");
    pdf.bake(what.annotations, what.fields);
    pdf.endOperation();
    // MuPDF's in-memory page objects keep listing baked widgets until the file is reloaded.
    const bytes = pdf.saveToBuffer("").asUint8Array().slice();
    const fresh = mupdf.Document.openDocument(bytes, "application/pdf");
    safe(() => fresh.asPDF()?.enableJournal(), undefined);
    entry.doc.destroy();
    entry.doc = fresh;
    entry.text.clear();
    entry.savedPosition = 0;
    // Flattening can't be undone, but the file on disk still has the fields until it's saved.
    entry.dirtyOutsideJournal = true;
    return { pages: null };
  }

  /** Reads a .pfx/.p12 identity; returns who it belongs to (the key stays in the engine). */
  openIdentity(p12: Uint8Array, password: string): Omit<Identity, "key" | "chain"> & { token: number } {
    const id = openIdentity(p12, password);
    const token = this.nextIdentity++;
    this.identities.set(token, id);
    const { key: _k, chain: _c, ...rest } = id;
    return { ...rest, token };
  }

  forgetIdentity(token: number): void {
    this.identities.delete(token);
  }

  /**
   * Signs the document with a certificate. Returns the signed file; the open document is replaced
   * by it (signing is a save, so it can't be undone).
   */
  async sign(docId: number, token: number, opts: SignOptions): Promise<Uint8Array> {
    const identity = this.identities.get(token);
    if (!identity) throw new EngineError("Open the certificate again to sign.", "sign-failed");
    const entry = this.get(docId);
    const pdf = this.requirePdf(docId);
    let signed: Uint8Array;
    try {
      signed = await signDocument(pdf, identity, opts);
    } catch (err) {
      throw new EngineError(err instanceof Error ? err.message : String(err), "sign-failed");
    }
    const fresh = mupdf.Document.openDocument(signed, "application/pdf");
    safe(() => fresh.asPDF()?.enableJournal(), undefined);
    entry.doc.destroy();
    entry.doc = fresh;
    entry.bytes = signed.slice();
    entry.text.clear();
    entry.savedPosition = 0;
    entry.dirtyOutsideJournal = true;
    return signed;
  }

  /** Verifies signatures against the file as last opened or saved. */
  async signatures(docId: number): Promise<SignatureInfo[]> {
    const pdf = this.pdf(docId);
    if (!pdf) return [];
    return verifySignatures(pdf, this.get(docId).bytes);
  }

  /** Tells the engine what's now on disk (after a save), so signature checks use the right bytes. */
  setFileBytes(docId: number, bytes: Uint8Array): void {
    this.get(docId).bytes = bytes.slice();
  }

  /** All comments as an XFDF document (Acrobat's comment exchange format). */
  exportXfdf(docId: number, fileName: string): string {
    return toXfdf(exportItems(this.requirePdf(docId)), fileName);
  }

  importXfdf(docId: number, xml: string, fallbackAuthor: string): EditResult & { imported: number; skipped: number } {
    let items;
    try {
      items = fromXfdf(xml);
    } catch (err) {
      throw new EngineError(err instanceof Error ? err.message : String(err), "edit-failed");
    }
    return this.edit(docId, "Import comments", (pdf) => importItems(pdf, items, fallbackAuthor));
  }

  // ---- Page organisation. Results report pages: null because page numbering may change. ----

  movePages(docId: number, pages: number[], to: number): EditResult {
    return this.structural(docId, pages.length > 1 ? "Move pages" : "Move page", (pdf) => void movePages(pdf, pages, to));
  }

  deletePages(docId: number, pages: number[]): EditResult {
    return this.structural(docId, pages.length > 1 ? `Delete ${pages.length} pages` : "Delete page", (pdf) => deletePages(pdf, pages));
  }

  duplicatePages(docId: number, pages: number[]): EditResult {
    return this.structural(docId, "Duplicate pages", (pdf) => duplicatePages(pdf, pages));
  }

  rotatePages(docId: number, pages: number[], by: 90 | -90 | 180): EditResult {
    return this.structural(docId, "Rotate pages", (pdf) => rotatePages(pdf, pages, by));
  }

  insertBlankPage(docId: number, at: number, size: [number, number]): EditResult {
    return this.structural(docId, "Insert blank page", (pdf) => insertBlank(pdf, at, size));
  }

  insertPagesFrom(docId: number, at: number, bytes: Uint8Array, pages?: number[], password?: string): EditResult & { inserted: number } {
    const src = openPdf(bytes, password);
    let inserted = 0;
    const r = this.structural(docId, "Insert pages", (pdf) => void (inserted = insertFrom(pdf, at, src, pages)));
    return { ...r, inserted };
  }

  insertImagePage(docId: number, at: number, image: Uint8Array): EditResult {
    return this.structural(docId, "Insert image as page", (pdf) => insertImagePage(pdf, at, image));
  }

  replacePages(docId: number, pages: number[], bytes: Uint8Array, srcPages: number[], password?: string): EditResult {
    const src = openPdf(bytes, password);
    return this.structural(docId, "Replace pages", (pdf) => replacePages(pdf, pages, src, srcPages));
  }

  extractPages(docId: number, pages: number[]): Uint8Array {
    return extractPages(this.requirePdf(docId), pages);
  }

  splitDocument(docId: number, plan: SplitPlan): { label: string; bytes: Uint8Array }[] {
    try {
      return splitDocument(this.requirePdf(docId), plan);
    } catch (err) {
      throw new EngineError(err instanceof Error ? err.message : String(err), "edit-failed");
    }
  }

  mergeFiles(files: { name: string; bytes: Uint8Array; password?: string }[], bookmarks: boolean): Uint8Array {
    try {
      return mergeDocuments(files, bookmarks);
    } catch (err) {
      throw new EngineError(err instanceof Error ? err.message : String(err), "edit-failed");
    }
  }

  cropPages(docId: number, pages: number[], margins: { top: number; right: number; bottom: number; left: number }): EditResult {
    return this.structural(docId, "Crop pages", (pdf) => cropPages(pdf, pages, margins));
  }

  cropToContent(docId: number, pages: number[]): EditResult {
    return this.structural(docId, "Crop to content", (pdf) => cropToContent(pdf, pages));
  }

  resizePages(docId: number, pages: number[], size: [number, number], scaleContent: boolean): EditResult {
    return this.structural(docId, "Change page size", (pdf) => resizePages(pdf, pages, size, scaleContent));
  }

  // ---- Content editing ----

  textLines(docId: number, pageIndex: number): TextLine[] {
    const pdf = this.requirePdf(docId);
    return readPage(this.pdfPage(pdf, pageIndex)).lines.map((l) => l.info);
  }

  images(docId: number, pageIndex: number): ImageInfo[] {
    const pdf = this.requirePdf(docId);
    return readPage(this.pdfPage(pdf, pageIndex)).images.map((i) => i.info);
  }

  /** Replaces a line's text. `expected` guards against the page having changed since the line was read. */
  replaceLine(docId: number, pageIndex: number, index: number, expected: string, text: string): EditResult & { usedFont: string; substituted: boolean; lossy: boolean } {
    let out = { usedFont: "", substituted: false, lossy: false };
    const r = this.edit(docId, "Edit text", (pdf) => {
      const page = this.pdfPage(pdf, pageIndex);
      const line = readPage(page).lines[index];
      if (!line || line.info.text !== expected) throw new Error("The page changed; select the text again.");
      out = replaceLine(pdf, page, line, text);
      return { pages: [pageIndex] };
    });
    this.get(docId).text.delete(pageIndex);
    return { ...r, ...out };
  }

  addText(docId: number, pageIndex: number, origin: Point, text: string, style: { size: number; color: Color; family: FontFamily; bold: boolean; italic: boolean }): EditResult & { lossy: boolean } {
    let lossy = false;
    const r = this.edit(docId, "Add text", (pdf) => {
      lossy = addText(pdf, this.pdfPage(pdf, pageIndex), origin, text, style).lossy;
      return { pages: [pageIndex] };
    });
    this.get(docId).text.delete(pageIndex);
    return { ...r, lossy };
  }

  deleteImage(docId: number, pageIndex: number, index: number): EditResult {
    return this.imageEdit(docId, pageIndex, index, "Delete image", (_pdf, page, img) => deleteImage(page, img.info.rect));
  }

  moveImage(docId: number, pageIndex: number, index: number, rect: Rect): EditResult {
    return this.imageEdit(docId, pageIndex, index, "Move image", (pdf, page, img) => moveImage(pdf, page, img.image, img.info.rect, rect));
  }

  replaceImage(docId: number, pageIndex: number, index: number, bytes: Uint8Array): EditResult {
    return this.imageEdit(docId, pageIndex, index, "Replace image", (pdf, page, img) => replaceImage(pdf, page, img.info.rect, bytes));
  }

  insertImage(docId: number, pageIndex: number, rect: Rect, bytes: Uint8Array): EditResult {
    return this.edit(docId, "Add image", (pdf) => (insertImage(pdf, this.pdfPage(pdf, pageIndex), rect, bytes), { pages: [pageIndex] }));
  }

  private imageEdit(
    docId: number,
    pageIndex: number,
    index: number,
    label: string,
    fn: (pdf: mupdf.PDFDocument, page: mupdf.PDFPage, img: { info: ImageInfo; image: mupdf.Image }) => void,
  ): EditResult {
    const r = this.edit(docId, label, (pdf) => {
      const page = this.pdfPage(pdf, pageIndex);
      const img = readPage(page).images[index];
      if (!img) throw new Error("That image no longer exists.");
      fn(pdf, page, img);
      return { pages: [pageIndex] };
    });
    this.get(docId).text.delete(pageIndex);
    return r;
  }

  addLink(docId: number, pageIndex: number, rect: Rect, target: { uri: string } | { page: number }): EditResult {
    if ("uri" in target && !/^(https?:|mailto:)/i.test(target.uri)) throw new EngineError("Links can point to web pages (https://…) or email addresses (mailto:…).", "edit-failed");
    return this.edit(docId, "Add link", (pdf) => (addLink(this.pdfPage(pdf, pageIndex), rect, target), { pages: [pageIndex] }));
  }

  deleteLink(docId: number, pageIndex: number, index: number): EditResult {
    return this.edit(docId, "Delete link", (pdf) => (deleteLink(this.pdfPage(pdf, pageIndex), index), { pages: [pageIndex] }));
  }

  setOutline(docId: number, nodes: OutlineEdit[]): EditResult {
    return this.edit(docId, "Edit bookmarks", (pdf) => (setOutline(pdf, nodes), { pages: [] }));
  }

  setMetadata(docId: number, fields: Partial<Record<"Title" | "Author" | "Subject" | "Keywords", string>>): EditResult {
    return this.edit(docId, "Edit document properties", (pdf) => (setMetadata(pdf, fields), { pages: [] }));
  }

  addAttachment(docId: number, name: string, mime: string, bytes: Uint8Array): EditResult {
    return this.edit(docId, "Attach file", (pdf) => (addAttachment(pdf, name, mime, bytes), { pages: [] }));
  }

  deleteAttachment(docId: number, name: string): EditResult {
    return this.edit(docId, "Remove attachment", (pdf) => (deleteAttachment(pdf, name), { pages: [] }));
  }

  // ---- Redaction ----

  redactionPresets(): { id: string; label: string }[] {
    return PRESETS.map(({ id, label }) => ({ id, label }));
  }

  /** Finds text to redact: a preset (by id) or the caller's own text/regex. */
  findForRedaction(docId: number, query: { preset?: string; text?: string; regex?: boolean; caseSensitive?: boolean }): SearchHit[] {
    const preset = query.preset ? PRESETS.find((p) => p.id === query.preset) : undefined;
    if (query.preset && !preset) throw new EngineError("Unknown pattern.", "bad-query");
    const pattern = preset ? preset.pattern : query.text ?? "";
    const hits = this.search(docId, pattern, { caseSensitive: preset ? true : !!query.caseSensitive, wholeWord: false, regex: preset ? true : !!query.regex }, 0, Infinity);
    return preset?.validate ? hits.filter((h) => preset.validate!(h.match)) : hits;
  }

  markForRedaction(docId: number, items: { page: number; quads?: Quad[]; rect?: Rect }[], overlayText?: string): EditResult & { marked: number } {
    let marked = 0;
    const pages = [...new Set(items.map((i) => i.page))];
    const r = this.edit(docId, items.length > 1 ? "Mark for redaction" : "Mark for redaction", (pdf) => {
      for (const p of pages) marked += markForRedaction(this.pdfPage(pdf, p), items.filter((i) => i.page === p), overlayText);
      return { pages };
    });
    return { ...r, marked };
  }

  redactionMarkCount(docId: number): number {
    const pdf = this.pdf(docId);
    return pdf ? countRedactionMarks(pdf) : 0;
  }

  /** Permanently removes marked content. The next save rewrites the file so nothing survives in older revisions. */
  applyRedactions(docId: number, opts: ApplyOptions): EditResult {
    const entry = this.get(docId);
    const r = this.edit(docId, "Apply redactions", (pdf) => ({ pages: applyRedactions(pdf, opts) }));
    entry.text.clear();
    entry.requireFullSave = true;
    return r;
  }

  sanitize(docId: number, opts: SanitizeOptions): EditResult & { report: SanitizeReport } {
    const entry = this.get(docId);
    let report!: SanitizeReport;
    const r = this.edit(docId, "Remove hidden information", (pdf) => ((report = sanitize(pdf, opts)), { pages: null }));
    entry.requireFullSave = true;
    return { ...r, report };
  }

  // ---- Page marks ----

  /** Returns whether some characters couldn't be shown (headers use Helvetica, Latin-1 only). */
  addHeaderFooter(docId: number, spec: HeaderFooterSpec): EditResult & { lossy: boolean } {
    let lossy = false;
    const r = this.edit(docId, "Add header and footer", (pdf) => ((lossy = addHeaderFooter(pdf, spec)), { pages: spec.pages }));
    this.get(docId).text.clear();
    return { ...r, lossy };
  }

  addWatermark(docId: number, spec: WatermarkSpec): EditResult & { lossy: boolean } {
    let lossy = false;
    const r = this.edit(docId, "Add watermark", (pdf) => ((lossy = addWatermark(pdf, spec)), { pages: spec.pages }));
    this.get(docId).text.clear();
    return { ...r, lossy };
  }

  addBackground(docId: number, spec: BackgroundSpec): EditResult {
    return this.edit(docId, "Add background", (pdf) => (addBackground(pdf, spec), { pages: spec.pages }));
  }

  removeMarks(docId: number, kind?: MarkKind): EditResult & { removed: number } {
    let removed = 0;
    const label = kind === "headerfooter" ? "Remove header and footer" : kind === "watermark" ? "Remove watermark" : kind === "background" ? "Remove background" : "Remove page marks";
    const r = this.edit(docId, label, (pdf) => ((removed = removeMarks(pdf, kind)), { pages: null }));
    this.get(docId).text.clear();
    return { ...r, removed };
  }

  markKinds(docId: number): MarkKind[] {
    const pdf = this.pdf(docId);
    return pdf ? markKinds(pdf) : [];
  }

  /** Marks a document as changed without an undo step (e.g. one restored from crash recovery). */
  markDirty(docId: number): void {
    this.get(docId).dirtyOutsideJournal = true;
  }

  undo(docId: number): EditResult {
    const pdf = this.requirePdf(docId);
    if (pdf.canUndo()) pdf.undo();
    this.get(docId).text.clear();
    return { pages: null };
  }

  redo(docId: number): EditResult {
    const pdf = this.requirePdf(docId);
    if (pdf.canRedo()) pdf.redo();
    this.get(docId).text.clear();
    return { pages: null };
  }

  editState(docId: number): EditState {
    const entry = this.get(docId);
    const pdf = entry.doc.asPDF();
    if (!pdf) return { canUndo: false, canRedo: false, dirty: false, undoLabel: null, redoLabel: null };
    const j = safe(() => pdf.getJournal(), { position: 0, steps: [] as string[] });
    return {
      canUndo: j.position > 0,
      canRedo: j.position < j.steps.length,
      dirty: j.position !== entry.savedPosition || entry.dirtyOutsideJournal === true,
      undoLabel: j.steps[j.position - 1] ?? null,
      redoLabel: j.steps[j.position] ?? null,
    };
  }

  /**
   * Serialises the document. Incremental saves append changes to the original bytes (which keeps
   * existing digital signatures valid); full saves rewrite and tidy the file.
   * With `markSaved`, the document stops counting as changed.
   */
  save(docId: number, opts: { incremental?: boolean; markSaved?: boolean } = {}): Uint8Array {
    const entry = this.get(docId);
    const pdf = this.requirePdf(docId);
    const incremental = opts.incremental !== false && !entry.requireFullSave && safe(() => pdf.canBeSavedIncrementally(), false);
    const bytes = pdf.saveToBuffer(incremental ? "incremental" : "garbage=compact,compress").asUint8Array().slice();
    if (opts.markSaved !== false) {
      entry.savedPosition = safe(() => pdf.getJournal().position, 0);
      entry.dirtyOutsideJournal = false;
      entry.requireFullSave = false;
    }
    return bytes;
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

  /** A change that may renumber or resize pages: one undo step, and cached text is dropped. */
  private structural(docId: number, label: string, fn: (pdf: mupdf.PDFDocument) => void): EditResult {
    const r = this.edit(docId, label, (pdf) => {
      fn(pdf);
      return { pages: null };
    });
    this.get(docId).text.clear();
    return r;
  }

  /** Runs a change as one undoable step. */
  private edit<T>(docId: number, label: string, fn: (pdf: mupdf.PDFDocument) => T): T {
    const pdf = this.requirePdf(docId);
    pdf.beginOperation(label);
    try {
      const result = fn(pdf);
      pdf.endOperation();
      return result;
    } catch (err) {
      safe(() => pdf.abandonOperation(), undefined);
      throw new EngineError(err instanceof Error ? err.message : String(err), "edit-failed");
    }
  }

  private requirePdf(docId: number): mupdf.PDFDocument {
    const pdf = this.pdf(docId);
    if (!pdf) throw new EngineError("Only PDF documents can be changed.", "edit-failed");
    return pdf;
  }

  private pdfPage(pdf: mupdf.PDFDocument, index: number): mupdf.PDFPage {
    if (index < 0 || index >= pdf.countPages()) throw new EngineError(`Page ${index + 1} doesn't exist.`, "bad-page");
    return pdf.loadPage(index);
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

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function openPdf(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf");
  } catch (err) {
    throw new EngineError(`That file couldn't be opened as a PDF (${errText(err)}).`, "invalid-file");
  }
  if (doc.needsPassword() && !(password && doc.authenticatePassword(password))) {
    throw new EngineError("That PDF is password-protected.", "bad-password");
  }
  const pdf = doc.asPDF();
  if (!pdf) throw new EngineError("That file isn't a PDF.", "invalid-file");
  return pdf;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
