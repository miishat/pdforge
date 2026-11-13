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
import { buildPattern, hitSnippet, searchLayer, searchText } from "./textlayer";
import { plainPageText } from "./plaintext";
import { sha256Hex, unpackPlainText } from "./plainStore";
import {
  describeEncryption, fromEnginePermissions, securityOptions, validateSecurity,
  type PendingSecurity, type PermissionSet, type SecuritySpec,
} from "./protect";
import { convertToPdf, documentModel, toDocx, toHtml, toMarkdown, toText, toTiff } from "./convert";
import { addOcrLayer, hasOcrLayer, hasText, ocrImage, removeOcrLayer, type OcrPage } from "./ocr";
import { compareWords, diffRegions, wordsOf, type TextComparison, type Word } from "./compare";
import { findAllTables, toXlsx, type Table } from "./tables";
import { applyAccessibilityFixes, checkAccessibility, type A11yFixes, type A11yReport } from "./a11y";
import { hasSignatures, pdfA, type PdfAReport } from "./pdfa";
import { compressImages, saveOptionsFor, type CompressOptions, type CompressReport } from "./optimize";
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
  HitSnippet,
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
/** Plain page text kept for searching; about 1 byte a character, so this is roughly 200 MB at most. */
const PLAIN_TEXT_BUDGET = 200_000_000;

/**
 * Recently used text layers (with character positions), plus the plain text of every page searched so far.
 * Searching reads the plain text only; positions are worked out for the pages on screen.
 */
class TextCache extends Map<number, TextLayer> {
  readonly plain = new Map<number, string>();
  plainChars = 0;
  /** Goes up whenever page text may have changed, so text read elsewhere from older bytes is refused. */
  revision = 0;
  override clear() {
    super.clear();
    this.plain.clear();
    this.plainChars = 0;
    this.revision++;
  }
  /** Forgets one page after it has been edited. */
  invalidate(page: number) {
    this.revision++;
    this.delete(page);
    const t = this.plain.get(page);
    if (t !== undefined) this.plainChars -= t.length;
    this.plain.delete(page);
  }
}

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
  text: TextCache;
  /** The file as it is on disk (needed for signatures, which cover exact bytes). */
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, worked out when first asked for. */
  fingerprint?: { bytes: Uint8Array; hex: string };
  /** Set by operations that can't be undone (e.g. flattening), so the tab still shows unsaved changes. */
  dirtyOutsideJournal?: boolean;
  /** Changes counted for `changeStamp`: every edit, undo, redo and change made outside the journal. */
  outsideEdits?: number;
  /**
   * After redaction or sanitising, an incremental save would keep the removed content in the file's
   * earlier revision, so the next save must rewrite the whole file.
   */
  requireFullSave?: boolean;
  /** Journal position at the last save; the document is dirty when the position differs. */
  savedPosition: number;
  /** MuPDF options for the next full save (set by compressing or repairing). */
  saveOptions?: string;
  /** Encryption to add or remove when the file is next saved. */
  pendingSecurity?: PendingSecurity;
  /** The password the file was opened with, and whether it was the owner (permissions) password. */
  password?: string;
  ownerAccess: boolean;
  /**
   * Whether opening needs a password. Recorded at open: MuPDF's needsPassword() forgets an
   * earlier successful authentication, so it must not be called afterwards.
   */
  hasOpenPassword: boolean;
  /** A layer was shown or hidden: pages no longer draw the way the file alone would. */
  layersChanged?: boolean;
}

/** Files larger than this aren't copied to the drawing helpers (each helper would hold its own copy). */
export const DRAWING_COPY_MAX_BYTES = 300 * 1024 * 1024;

/** Numbers each distinct `bytes` array an open document has had, so helpers can tell whether their copy is current. */
const bytesStamps = new WeakMap<Uint8Array, number>();
let nextBytesStamp = 1;
function stampOf(bytes: Uint8Array): number {
  let s = bytesStamps.get(bytes);
  if (s === undefined) bytesStamps.set(bytes, (s = nextBytesStamp++));
  return s;
}

/** What `drawingSource` reports: whether a copy of the file draws exactly what's open, and the copy if needed. */
export type DrawingSource =
  | { shareable: false }
  | { shareable: true; stamp: number; bytes?: Uint8Array };

/** What to find for redaction: one of the presets (by id), or the user's own text or pattern. */
export interface RedactionQuery {
  preset?: string;
  text?: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface SecurityState {
  encrypted: boolean;
  /** e.g. "AES 256-bit". */
  method: string;
  /** RC4 or keys shorter than 128 bits. */
  weak: boolean;
  /** Whether opening the file needs a password. */
  hasOpenPassword: boolean;
  /** Whether security can be changed (no owner password, or it was given). */
  canChange: boolean;
  permissions: PermissionSet;
  pending: "encrypt" | "decrypt" | null;
}

export interface RepairReport {
  /** MuPDF had to rebuild the file's structure to read it. */
  wasRepaired: boolean;
  pageCount: number;
  /** Pages (0-based) that still fail to draw. */
  brokenPages: number[];
  objects: number;
}

export class PdfEngine {
  private docs = new Map<number, OpenDoc>();
  private nextId = 1;
  private identities = new Map<number, Identity>();
  private nextIdentity = 1;

  /** Opens a PDF. The engine keeps `bytes` (never changing them) as the file on disk, so callers shouldn't change them either. */
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
    // A file with only an owner password opens without one, but its permissions can't be changed yet.
    const hasOpenPassword = doc.needsPassword();
    this.docs.set(docId, { doc, text: new TextCache(), bytes, savedPosition: 0, ownerAccess: !isEncrypted(doc), hasOpenPassword });
    if (hasOpenPassword) return { status: "needs-password", docId };
    return { status: "ok", info: this.info(docId) };
  }

  /**
   * Opens a file only for drawing its pages (in a drawing helper): no undo journal and no page list, so it's quick
   * even for thousands of pages. Returns the document's id in this engine.
   */
  openForDrawing(bytes: Uint8Array): number {
    let doc: mupdf.Document;
    try {
      doc = mupdf.Document.openDocument(bytes, "application/pdf");
    } catch (err) {
      throw new EngineError(`This file couldn't be opened as a PDF (${errText(err)}).`, "invalid-file");
    }
    const docId = this.nextId++;
    this.docs.set(docId, { doc, text: new TextCache(), bytes, savedPosition: 0, ownerAccess: true, hasOpenPassword: doc.needsPassword() });
    return docId;
  }

  /**
   * For drawing pages in helper workers: whether a copy of the file on disk draws exactly what's open (no changes
   * since opening or saving, no password, no layers switched). `knownStamp` is the copy the helpers already have;
   * the bytes are included only when it's out of date (and the file isn't too large to copy).
   */
  drawingSource(docId: number, knownStamp: number | null): DrawingSource {
    const entry = this.get(docId);
    if (entry.layersChanged || !this.unchangedOnDisk(entry)) return { shareable: false };
    const stamp = stampOf(entry.bytes);
    if (stamp === knownStamp) return { shareable: true, stamp };
    if (entry.bytes.length > DRAWING_COPY_MAX_BYTES) return { shareable: false };
    return { shareable: true, stamp, bytes: entry.bytes.slice() };
  }

  /** Returns document info if the password is right; throws `bad-password` otherwise. */
  unlock(docId: number, password: string): DocInfo {
    const entry = this.get(docId);
    const result = entry.doc.authenticatePassword(password);
    if (!result) {
      throw new EngineError("That password isn't right.", "bad-password");
    }
    entry.password = password;
    // 4 = owner password; 6 = both passwords are the same.
    entry.ownerAccess = (result & 4) !== 0;
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
      repaired: safe(() => doc.asPDF()?.wasRepaired() ?? false, false),
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
      onChar(c, _origin, font, _size, quad) {
        // MuPDF hands out a font object per character; free it now; waiting for the garbage collector lets
        // them pile up (about 170 bytes a character) when many pages are read without a pause.
        font.destroy();
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

  /** The page's text as searching sees it: identical to its text layer's text, but much quicker to get. */
  plainText(docId: number, pageIndex: number): string {
    const entry = this.get(docId);
    const known = entry.text.get(pageIndex)?.text ?? entry.text.plain.get(pageIndex);
    if (known !== undefined) return known;
    if (pageIndex < 0 || pageIndex >= entry.doc.countPages()) throw new EngineError(`Page ${pageIndex + 1} doesn't exist.`, "bad-page");
    const text = plainPageText(entry.doc, pageIndex);
    this.keepPlain(entry, pageIndex, text);
    return text;
  }

  private keepPlain(entry: OpenDoc, pageIndex: number, text: string) {
    if (entry.text.plain.has(pageIndex) || entry.text.plainChars + text.length > PLAIN_TEXT_BUDGET) return;
    entry.text.plain.set(pageIndex, text);
    entry.text.plainChars += text.length;
  }

  /**
   * For reading page text in parallel in helper workers: the file's bytes, when they hold exactly what's open
   * (no changes since it was opened or saved), and how many pages still need their text read. Null otherwise.
   */
  textSource(docId: number): { bytes: Uint8Array; revision: number; missing: number } | null {
    const entry = this.get(docId);
    if (!this.unchangedOnDisk(entry)) return null;
    const missing = entry.doc.countPages() - entry.text.plain.size;
    return { bytes: entry.bytes, revision: entry.text.revision, missing };
  }

  /**
   * Accepts page text read by a helper worker from `textSource` bytes. Refused (false) if the document changed since,
   * or if a spot check of the first page disagrees with what's open.
   */
  seedText(docId: number, revision: number, from: number, texts: string[]): boolean {
    const entry = this.get(docId);
    if (revision !== entry.text.revision || !texts.length) return false;
    if (from + texts.length > entry.doc.countPages()) return false;
    if (this.plainText(docId, from) !== texts[0]) return false;
    texts.forEach((t, i) => this.keepPlain(entry, from + i, t));
    return true;
  }

  /** True when `bytes` hold exactly what's open (no changes since opening or saving) and no password protects it. */
  private unchangedOnDisk(entry: OpenDoc): boolean {
    const pdf = entry.doc.asPDF();
    if (!pdf || entry.hasOpenPassword) return false;
    return (
      !entry.dirtyOutsideJournal && !entry.requireFullSave && !entry.saveOptions && !entry.pendingSecurity &&
      safe(() => pdf.getJournal().position, 0) === entry.savedPosition
    );
  }

  /**
   * Identifies the file's exact contents, so page text saved to disk is only ever used for the same file.
   * Null when the document has changed since it was opened or saved, or needs a password (its text stays private).
   */
  async textFingerprint(docId: number): Promise<string | null> {
    const entry = this.get(docId);
    if (!this.unchangedOnDisk(entry)) return null;
    if (entry.fingerprint?.bytes === entry.bytes) return entry.fingerprint.hex;
    const bytes = entry.bytes;
    const hex = await sha256Hex(bytes);
    entry.fingerprint = { bytes, hex };
    return hex;
  }

  /** Every page's plain text, for saving. Null unless all of it has been read and the file is unchanged. */
  allPlainText(docId: number): string[] | null {
    const entry = this.get(docId);
    if (!this.unchangedOnDisk(entry)) return null;
    const count = entry.doc.countPages();
    const texts: string[] = new Array(count);
    for (let p = 0; p < count; p++) {
      const t = entry.text.get(p)?.text ?? entry.text.plain.get(p);
      if (t === undefined) return null;
      texts[p] = t;
    }
    return texts;
  }

  /**
   * Takes page text saved earlier for this file: `data` is `allPlainText` packed by `packPlainText`, or the texts
   * themselves. "rejected" if it's damaged, doesn't match the page count or fails a spot check against the open file
   * (so it should be thrown away); "changed" if the document changed meanwhile.
   */
  async importPlainText(docId: number, data: Uint8Array | string[]): Promise<"loaded" | "rejected" | "changed"> {
    const entry = this.get(docId);
    if (!this.unchangedOnDisk(entry)) return "changed";
    const revision = entry.text.revision;
    // Unpacked here rather than in a helper: handing 17,000 pages of text between threads costs more than unpacking.
    const texts = Array.isArray(data) ? data : await unpackPlainText(data);
    if (!this.docs.has(docId) || entry.text.revision !== revision || !this.unchangedOnDisk(entry)) return "changed";
    const count = entry.doc.countPages();
    if (!texts || texts.length !== count || !count) return "rejected";
    for (const p of new Set([0, count >> 1, count - 1])) if (this.plainText(docId, p) !== texts[p]) return "rejected";
    texts.forEach((t, p) => this.keepPlain(entry, p, t));
    return "loaded";
  }

  /** The first page from `from` (before `to`) whose plain text hasn't been read yet, or `to`. */
  firstUnread(docId: number, from: number, to: number): number {
    const entry = this.get(docId);
    const end = Math.min(to, entry.doc.countPages());
    let p = Math.max(0, from);
    while (p < end && (entry.text.plain.has(p) || entry.text.has(p))) p++;
    return p;
  }

  /**
   * Fast search for the find bar: scans pages from `from`, stopping at `to`, after `budgetMs`, or once it has `limit`
   * hits (finishing the page it's on).
   * Hits carry character offsets but no rectangles; work those out from the page's text layer when it's shown.
   */
  find(
    docId: number, query: string, opts: SearchOptions, from: number, to: number, limit = 5000, budgetMs = 60, readMissing = true,
    snippets = true,
  ): { hits: SearchHit[]; next: number } {
    const { doc } = this.get(docId);
    const pattern = buildPattern(query, opts);
    if (!pattern) throw new EngineError("That search pattern isn't valid.", "bad-query");
    const hits: SearchHit[] = [];
    // With `readMissing` off, stop at the first page whose text a helper worker hasn't delivered yet.
    const end = readMissing ? Math.min(to, doc.countPages()) : this.firstUnread(docId, from, to);
    const started = Date.now();
    let p = Math.max(0, from);
    while (p < end && hits.length < limit) {
      // Whole pages only: `next` must not skip hits left on a page, so a batch may end a little over `limit`.
      for (const h of searchText(this.plainText(docId, p), p, pattern, Infinity, undefined, snippets)) hits.push(h);
      p++;
      if (Date.now() - started >= budgetMs) break;
    }
    return { hits, next: p };
  }

  /**
   * The text around each hit (found by `find` without snippets), for the rows of the results list on screen.
   * A hit on a page that no longer exists (pages deleted since the search) gets null rather than failing the rest.
   */
  hitSnippets(docId: number, hits: { page: number; start: number; end: number }[]): (HitSnippet | null)[] {
    const count = this.get(docId).doc.countPages();
    return hits.map((h) => (h.page >= 0 && h.page < count ? hitSnippet(this.plainText(docId, h.page), h.start, h.end) : null));
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
    this.get(docId).layersChanged = true;
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
    entry.outsideEdits = (entry.outsideEdits ?? 0) + 1;
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
    entry.outsideEdits = (entry.outsideEdits ?? 0) + 1;
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
    this.get(docId).text.invalidate(pageIndex);
    return { ...r, ...out };
  }

  addText(docId: number, pageIndex: number, origin: Point, text: string, style: { size: number; color: Color; family: FontFamily; bold: boolean; italic: boolean }): EditResult & { lossy: boolean } {
    let lossy = false;
    const r = this.edit(docId, "Add text", (pdf) => {
      lossy = addText(pdf, this.pdfPage(pdf, pageIndex), origin, text, style).lossy;
      return { pages: [pageIndex] };
    });
    this.get(docId).text.invalidate(pageIndex);
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
    this.get(docId).text.invalidate(pageIndex);
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

  /** Finds every match to redact in the whole document: a preset (by id) or the caller's own text or pattern. */
  findForRedaction(docId: number, query: RedactionQuery): SearchHit[] {
    return this.findForRedactionBatch(docId, query, 0, Infinity).hits;
  }

  /**
   * Finds matches to redact from page `from` on, for about `budgetMs` (then call again from `next`, which is the page
   * count when done). There is no limit on matches: every one must be found, or text would be left in the file.
   * Pages are scanned in their plain text (quick); positions are worked out only on pages that have matches.
   */
  findForRedactionBatch(docId: number, query: RedactionQuery, from: number, budgetMs = 60): { hits: SearchHit[]; next: number } {
    const preset = query.preset ? PRESETS.find((p) => p.id === query.preset) : undefined;
    if (query.preset && !preset) throw new EngineError("Unknown pattern.", "bad-query");
    const opts = { caseSensitive: preset ? true : !!query.caseSensitive, wholeWord: false, regex: preset ? true : !!query.regex };
    const pattern = buildPattern(preset ? preset.pattern : query.text ?? "", opts);
    if (!pattern) throw new EngineError("That search pattern isn't valid.", "bad-query");
    const count = this.get(docId).doc.countPages();
    const hits: SearchHit[] = [];
    const started = Date.now();
    let p = Math.max(0, from);
    while (p < count) {
      if (searchText(this.plainText(docId, p), p, pattern, 1, undefined, false).length) {
        for (const h of searchLayer(this.textLayer(docId, p), p, pattern)) {
          if (!preset?.validate || preset.validate(h.match ?? "")) hits.push(h);
        }
      }
      p++;
      if (Date.now() - started >= budgetMs) break;
    }
    return { hits, next: p };
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
    this.get(docId).outsideEdits = (this.get(docId).outsideEdits ?? 0) + 1;
  }

  undo(docId: number): EditResult {
    const pdf = this.requirePdf(docId);
    if (pdf.canUndo()) pdf.undo();
    this.get(docId).text.clear();
    this.touch(docId);
    return { pages: null };
  }

  redo(docId: number): EditResult {
    const pdf = this.requirePdf(docId);
    if (pdf.canRedo()) pdf.redo();
    this.get(docId).text.clear();
    this.touch(docId);
    return { pages: null };
  }

  /** Changes whenever the document's content does (an edit, undo or redo); for knowing when to write a recovery copy. */
  changeStamp(docId: number): string {
    const entry = this.get(docId);
    const pos = safe(() => entry.doc.asPDF()?.getJournal().position ?? 0, 0);
    return `${pos}:${entry.outsideEdits ?? 0}:${entry.pendingSecurity ? 1 : 0}:${entry.saveOptions ?? ""}`;
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
    const incremental =
      opts.incremental !== false && !entry.requireFullSave && !entry.pendingSecurity && !entry.saveOptions &&
      safe(() => pdf.canBeSavedIncrementally(), false);
    const options = incremental ? "incremental" : this.fullSaveOptions(entry);
    let bytes: Uint8Array;
    try {
      bytes = incremental ? pdf.saveToBuffer(options).asUint8Array().slice() : this.write(entry, pdf, options);
    } catch (err) {
      throw new EngineError(`The file couldn't be written (${errText(err)}).`, "edit-failed");
    }
    if (opts.markSaved !== false) {
      const pending = entry.pendingSecurity;
      entry.dirtyOutsideJournal = false;
      entry.requireFullSave = false;
      entry.saveOptions = undefined;
      entry.pendingSecurity = undefined;
      if (pending) {
        // The open document still has the old encryption; continue from what was written.
        const password = pending.kind === "encrypt" ? pending.spec.ownerPassword : undefined;
        this.replaceDoc(entry, bytes, password);
        entry.password = password;
        entry.ownerAccess = true;
      } else {
        entry.savedPosition = safe(() => pdf.getJournal().position, 0);
      }
    }
    return bytes;
  }

  // ---- Protect: security, compression, repair ----

  security(docId: number): SecurityState {
    const entry = this.get(docId);
    const enc = describeEncryption(entry.doc.getMetaData("encryption") || null);
    return {
      encrypted: enc.encrypted,
      method: enc.label,
      weak: enc.weak,
      hasOpenPassword: entry.hasOpenPassword,
      canChange: entry.ownerAccess,
      permissions: fromEnginePermissions(this.permissions(entry.doc)),
      pending: entry.pendingSecurity?.kind ?? null,
    };
  }

  /** Gives the permissions password for a file that opened without one, so its security can be changed. */
  unlockOwner(docId: number, password: string): SecurityState {
    const entry = this.get(docId);
    const result = entry.doc.authenticatePassword(password);
    if (!(result & 4)) throw new EngineError("That isn't the permissions password.", "bad-password");
    entry.password = password;
    entry.ownerAccess = true;
    return this.security(docId);
  }

  /** Protects the file with AES-256 when it's next saved. */
  setSecurity(docId: number, spec: SecuritySpec): SecurityState {
    const entry = this.get(docId);
    this.requirePdf(docId);
    if (!entry.ownerAccess) throw new EngineError("Enter the permissions password first.", "bad-password");
    const problem = validateSecurity(spec);
    if (problem) throw new EngineError(problem, "edit-failed");
    entry.pendingSecurity = { kind: "encrypt", spec };
    entry.dirtyOutsideJournal = true;
    entry.outsideEdits = (entry.outsideEdits ?? 0) + 1;
    return this.security(docId);
  }

  /** Removes passwords and restrictions when the file is next saved. */
  removeSecurity(docId: number): SecurityState {
    const entry = this.get(docId);
    this.requirePdf(docId);
    if (!entry.ownerAccess) throw new EngineError("Enter the permissions password first.", "bad-password");
    entry.pendingSecurity = isEncrypted(entry.doc) ? { kind: "decrypt" } : undefined;
    if (entry.pendingSecurity) entry.dirtyOutsideJournal = true;
    entry.outsideEdits = (entry.outsideEdits ?? 0) + 1;
    return this.security(docId);
  }

  /** Drops a security change that hasn't been saved yet. */
  cancelSecurityChange(docId: number): SecurityState {
    const entry = this.get(docId);
    entry.pendingSecurity = undefined;
    return this.security(docId);
  }

  /**
   * Shrinks images and fonts (one undo step) and sets up a tidy full rewrite for the next save.
   * Returns the file size before and after, measured by writing the file.
   */
  compress(docId: number, opts: CompressOptions): EditResult & { report: CompressReport; before: number; after: number } {
    const entry = this.get(docId);
    const pdf = this.requirePdf(docId);
    const before = this.measure(entry, pdf);
    const report = this.edit(docId, "Compress", (p) => compressImages(p, opts));
    entry.text.clear();
    entry.saveOptions = saveOptionsFor(opts);
    entry.requireFullSave = true;
    const after = this.measure(entry, pdf);
    return { pages: null, report, before, after };
  }

  /** Size of the file as it would be written now. */
  fileSize(docId: number): number {
    const entry = this.get(docId);
    return this.measure(entry, this.requirePdf(docId));
  }

  /** Checks every page and sets up a clean rewrite of the file's structure for the next save. */
  repair(docId: number): RepairReport {
    const entry = this.get(docId);
    const pdf = this.requirePdf(docId);
    const brokenPages: number[] = [];
    const device = new mupdf.Device({});
    for (let i = 0; i < pdf.countPages(); i++) {
      try {
        const page = pdf.loadPage(i);
        page.run(device, mupdf.Matrix.identity);
        page.destroy();
      } catch {
        brokenPages.push(i);
      }
    }
    device.close();
    entry.saveOptions = "garbage=compact,clean,compress";
    entry.requireFullSave = true;
    entry.dirtyOutsideJournal = true;
    entry.outsideEdits = (entry.outsideEdits ?? 0) + 1;
    return { wasRepaired: safe(() => pdf.wasRepaired(), false), pageCount: pdf.countPages(), brokenPages, objects: pdf.countObjects() };
  }

  // ---- OCR ----

  /** A page rendered for text recognition (grey, content only). */
  ocrImage(docId: number, pageIndex: number, dpi = 300): Uint8Array {
    const page = this.pdfPage(this.requirePdf(docId), pageIndex);
    try {
      return ocrImage(page, dpi);
    } finally {
      page.destroy();
    }
  }

  /** Which of the pages need recognising: those without real text (or every page, with `force`). */
  ocrCandidates(docId: number, pages: number[], force: boolean): { todo: number[]; skipped: number[] } {
    const pdf = this.requirePdf(docId);
    const todo: number[] = [];
    const skipped: number[] = [];
    for (const i of pages) {
      const page = this.pdfPage(pdf, i);
      // A page with only our own earlier OCR layer is recognised again (replacing the layer).
      if (force || hasOcrLayer(page) || !hasText(page)) todo.push(i);
      else skipped.push(i);
      page.destroy();
    }
    return { todo, skipped };
  }

  /** Lays recognised text over the pages, as one undoable step. */
  addOcrLayers(docId: number, items: OcrPage[]): EditResult {
    const r = this.edit(docId, items.length === 1 ? "Recognise text on page" : "Recognise text", (pdf) => {
      for (const item of items) {
        const page = this.pdfPage(pdf, item.page);
        addOcrLayer(pdf, page, item);
        page.destroy();
      }
      return { pages: items.map((i) => i.page) };
    });
    for (const i of items) this.get(docId).text.invalidate(i.page);
    return r;
  }

  /** Removes text layers PDForge added by OCR. */
  removeOcrLayers(docId: number): EditResult & { removed: number } {
    let removed = 0;
    const r = this.edit(docId, "Remove recognised text", (pdf) => {
      const pages: number[] = [];
      for (let i = 0; i < pdf.countPages(); i++) {
        const page = pdf.loadPage(i);
        if (removeOcrLayer(pdf, page)) {
          removed++;
          pages.push(i);
        }
        page.destroy();
      }
      return { pages };
    });
    this.get(docId).text.clear();
    return { ...r, removed };
  }

  // ---- Compare, tables, accessibility ----

  /** Word-level differences between two open documents. */
  compareText(docA: number, docB: number): TextComparison & { aPages: number; bPages: number } {
    const words = (docId: number) => {
      const { doc } = this.get(docId);
      const out: Word[] = [];
      for (let p = 0; p < doc.countPages(); p++) out.push(...wordsOf(this.textLayer(docId, p), p));
      return out;
    };
    const r = compareWords(words(docA), words(docB));
    return { ...r, aPages: this.get(docA).doc.countPages(), bPages: this.get(docB).doc.countPages() };
  }

  /**
   * Areas where page `pageA` of one document looks different from page `pageB` of another, in the
   * first page's coordinates. The second page is scaled to the first's size.
   */
  compareVisual(docA: number, pageA: number, docB: number, pageB: number, dpi = 50): Rect[] {
    const pa = this.page(this.get(docA).doc, pageA);
    const pb = this.page(this.get(docB).doc, pageB);
    try {
      const [ax0, ay0, ax1, ay1] = pa.getBounds();
      const [bx0, by0, bx1, by1] = pb.getBounds();
      const s = dpi / 72;
      const w = Math.max(1, Math.round((ax1 - ax0) * s));
      const h = Math.max(1, Math.round((ay1 - ay0) * s));
      const grey = (page: mupdf.Page, sx: number, sy: number) => {
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        page.run(dev, mupdf.Matrix.scale(sx, sy));
        dev.close();
        const stride = pix.getStride();
        const src = pix.getPixels();
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) out.set(src.subarray(y * stride, y * stride + w), y * w);
        pix.destroy();
        return out;
      };
      // Both pages are drawn into the same pixel grid with the exact scale that fills it, so
      // identical pages give identical pixels (rounding the size alone would shift edges).
      const sax = w / (ax1 - ax0);
      const say = h / (ay1 - ay0);
      const a = grey(pa, sax, say);
      const b = grey(pb, w / (bx1 - bx0), h / (by1 - by0));
      return diffRegions(a, b, w, h).map(([x0, y0, x1, y1]) => [x0 / sax + ax0, y0 / say + ay0, x1 / sax + ax0, y1 / say + ay0] as Rect);
    } finally {
      pa.destroy();
      pb.destroy();
    }
  }

  findTables(docId: number, pages?: number[]): Table[] {
    return findAllTables(this.get(docId).doc, pages);
  }

  async tablesToXlsx(tables: { name: string; rows: string[][] }[]): Promise<Uint8Array> {
    return toXlsx(tables);
  }

  checkAccessibility(docId: number, opts: { fileName: string; lang: string }): A11yReport {
    return checkAccessibility(this.requirePdf(docId), opts);
  }

  fixAccessibility(docId: number, fixes: A11yFixes): EditResult & { done: string[] } {
    const r = this.edit(docId, "Fix accessibility", (pdf) => ({ done: applyAccessibilityFixes(pdf, fixes, (nodes) => setOutline(pdf, nodes)) }));
    return { pages: [], ...r };
  }

  // ---- Convert ----

  exportText(docId: number, pages?: number[]): string {
    return toText(this.get(docId).doc, pages);
  }

  exportMarkdown(docId: number, opts: { images: boolean; pages?: number[] }): string {
    return toMarkdown(documentModel(this.get(docId).doc, opts));
  }

  exportHtml(docId: number, opts: { images: boolean; pages?: number[]; title: string }): string {
    return toHtml(documentModel(this.get(docId).doc, opts), opts.title);
  }

  async exportDocx(docId: number, opts: { images: boolean; pages?: number[]; title: string }): Promise<Uint8Array> {
    return toDocx(documentModel(this.get(docId).doc, opts), opts.title);
  }

  /**
   * Pages as images. PNG and JPEG give one file per page; TIFF can hold every page in one file.
   * Annotations are included, as they appear on screen.
   */
  async exportImages(
    docId: number,
    opts: { format: "png" | "jpeg" | "tiff"; dpi: number; pages: number[]; quality?: number; singleTiff?: boolean },
  ): Promise<{ page: number; bytes: Uint8Array }[]> {
    const { doc } = this.get(docId);
    const scale = opts.dpi / 72;
    const out: { page: number; bytes: Uint8Array }[] = [];
    const tiffPages: { width: number; height: number; rgb: Uint8Array; dpi: number }[] = [];
    for (const index of opts.pages) {
      const page = this.page(doc, index);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      page.destroy();
      pix.setResolution(opts.dpi, opts.dpi);
      if (opts.format === "png") out.push({ page: index, bytes: pix.asPNG().slice() });
      else if (opts.format === "jpeg") out.push({ page: index, bytes: pix.asJPEG(opts.quality ?? 90).slice() });
      else {
        const w = pix.getWidth();
        const h = pix.getHeight();
        const stride = pix.getStride();
        const src = pix.getPixels();
        const rgb = new Uint8Array(w * h * 3);
        for (let y = 0; y < h; y++) rgb.set(src.subarray(y * stride, y * stride + w * 3), y * w * 3);
        const p = { width: w, height: h, rgb, dpi: opts.dpi };
        if (opts.singleTiff) tiffPages.push(p);
        else out.push({ page: index, bytes: await toTiff([p]) });
      }
      pix.destroy();
    }
    if (opts.singleTiff && tiffPages.length) out.push({ page: opts.pages[0], bytes: await toTiff(tiffPages) });
    return out;
  }

  /** Office documents, web pages, text, e-books and images, laid out and written as one PDF. */
  convertToPdf(files: { name: string; bytes: Uint8Array }[], opts: { pageSize?: [number, number]; margin?: number; fitImages?: boolean } = {}): Uint8Array {
    try {
      return convertToPdf(files, opts);
    } catch (err) {
      throw new EngineError(errText(err), "invalid-file");
    }
  }

  /** Checks the document against the common PDF/A-2b requirements, without changing it. */
  checkPdfA(docId: number): PdfAReport {
    const entry = this.get(docId);
    const pdf = this.requirePdf(docId);
    return pdfA(pdf, { fix: false, encrypted: isEncrypted(entry.doc), signed: hasSignatures(pdf) });
  }

  /** Fixes what can be fixed for PDF/A-2b (one undo step) and reports what's left. */
  convertToPdfA(docId: number): EditResult & { report: PdfAReport } {
    const entry = this.get(docId);
    const pdf = this.requirePdf(docId);
    if (isEncrypted(entry.doc)) {
      return { pages: null, report: pdfA(pdf, { fix: false, encrypted: true, signed: hasSignatures(pdf) }) };
    }
    const signed = hasSignatures(pdf);
    const report = this.edit(docId, "Convert to PDF/A", (p) => pdfA(p, { fix: true, encrypted: false, signed }));
    entry.text.clear();
    // PDF/A metadata must describe the whole file; an incremental update would leave stale revisions.
    entry.requireFullSave = true;
    return { pages: null, report };
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

  private fullSaveOptions(entry: OpenDoc): string {
    const base = entry.saveOptions ?? "garbage=compact,compress";
    return entry.pendingSecurity ? `${base},${securityOptions(entry.pendingSecurity)}` : base;
  }

  private measure(entry: OpenDoc, pdf: mupdf.PDFDocument): number {
    const dirty = entry.dirtyOutsideJournal || entry.requireFullSave || entry.saveOptions || entry.pendingSecurity;
    if (!dirty && safe(() => pdf.getJournal().position, 0) === entry.savedPosition) return entry.bytes.length;
    return safe(() => this.write(entry, pdf, this.fullSaveOptions(entry)).length, entry.bytes.length);
  }

  /**
   * A full save. Some options (object streams, cleaning) change the document they write, which
   * would add an undo step, so those go through a temporary copy.
   */
  private write(entry: OpenDoc, pdf: mupdf.PDFDocument, options: string): Uint8Array {
    if (!/(^|,)(objstms|clean)(,|$)/.test(options)) return pdf.saveToBuffer(options).asUint8Array().slice();
    const copy = mupdf.Document.openDocument(pdf.saveToBuffer("").asUint8Array().slice(), "application/pdf");
    try {
      if (entry.password) copy.authenticatePassword(entry.password);
      return copy.asPDF()!.saveToBuffer(options).asUint8Array().slice();
    } finally {
      copy.destroy();
    }
  }

  /** Swaps in a freshly loaded copy of the document (journal restarts). */
  private replaceDoc(entry: OpenDoc, bytes: Uint8Array, password?: string) {
    const fresh = mupdf.Document.openDocument(bytes, "application/pdf");
    entry.hasOpenPassword = fresh.needsPassword();
    if (password) fresh.authenticatePassword(password);
    safe(() => fresh.asPDF()?.enableJournal(), undefined);
    entry.doc.destroy();
    entry.doc = fresh;
    entry.bytes = bytes.slice();
    entry.text.clear();
    entry.savedPosition = 0;
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
      this.touch(docId);
      return result;
    } catch (err) {
      safe(() => pdf.abandonOperation(), undefined);
      throw new EngineError(err instanceof Error ? err.message : String(err), "edit-failed");
    }
  }

  /** Counts a change to the document's content (see `changeStamp`). */
  private touch(docId: number) {
    const entry = this.get(docId);
    entry.outsideEdits = (entry.outsideEdits ?? 0) + 1;
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

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** MuPDF draws RGB; canvases want RGBA. Opaque pages, so alpha is always 255. */
export function rgbToRgba(pix: mupdf.Pixmap): Uint8ClampedArray {
  return rgbBytesToRgba(pix.getPixels(), pix.getWidth(), pix.getHeight(), pix.getStride());
}

export function rgbBytesToRgba(rgb: Uint8Array | Uint8ClampedArray, width: number, height: number, stride: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (!width || !height) return rgba;
  if (!LITTLE_ENDIAN) {
    for (let y = 0; y < height; y++) {
      let src = y * stride;
      let dst = y * width * 4;
      for (let x = 0; x < width; x++, src += 3, dst += 4) {
        rgba[dst] = rgb[src];
        rgba[dst + 1] = rgb[src + 1];
        rgba[dst + 2] = rgb[src + 2];
        rgba[dst + 3] = 255;
      }
    }
    return rgba;
  }
  const out = new Uint32Array(rgba.buffer);
  const pixels = width * height;
  // Rows packed back to back, starting on a 4-byte boundary (MuPDF's usual layout): read 4 pixels from 3 words.
  if (stride === width * 3 && rgb.byteOffset % 4 === 0) {
    const src = new Uint32Array(rgb.buffer, rgb.byteOffset, Math.floor((pixels * 3) / 4));
    let s = 0;
    let d = 0;
    for (const end = pixels - 3; d < end; d += 4, s += 3) {
      const a = src[s], b = src[s + 1], c = src[s + 2];
      out[d] = 0xff000000 | a;
      out[d + 1] = 0xff000000 | (a >>> 24) | (b << 8);
      out[d + 2] = 0xff000000 | (b >>> 16) | (c << 16);
      out[d + 3] = 0xff000000 | (c >>> 8);
    }
    for (let i = d * 3; d < pixels; d++, i += 3) out[d] = 0xff000000 | (rgb[i + 2] << 16) | (rgb[i + 1] << 8) | rgb[i];
    return rgba;
  }
  for (let y = 0; y < height; y++) {
    let src = y * stride;
    for (let d = y * width, end = d + width; d < end; d++, src += 3) out[d] = 0xff000000 | (rgb[src + 2] << 16) | (rgb[src + 1] << 8) | rgb[src];
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

function isEncrypted(doc: mupdf.Document): boolean {
  const e = doc.getMetaData("encryption");
  return !!e && e !== "None";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
