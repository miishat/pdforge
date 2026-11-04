// Shared types between the UI, the worker and the engine.
// Coordinates are in "page space": PDF points, origin top-left, y pointing down,
// after the page's own /Rotate (this is how MuPDF reports bounds).

export type Rect = [number, number, number, number];
export type Quad = [number, number, number, number, number, number, number, number];
export type ViewRotation = 0 | 90 | 180 | 270;

export interface PageSize {
  width: number;
  height: number;
}

export interface DocInfo {
  docId: number;
  pageCount: number;
  pages: PageSize[];
  title: string | null;
  author: string | null;
  format: string | null;
  /** Page labels, e.g. "iv" or "A-3"; null when the document defines none. */
  labels: string[] | null;
  permissions: Record<Permission, boolean>;
}

export type Permission = "print" | "copy" | "edit" | "annotate" | "form" | "accessibility" | "assemble" | "print-hq";

export type OpenResult =
  | { status: "ok"; info: DocInfo }
  | { status: "needs-password"; docId: number };

export interface RenderedPage {
  width: number;
  height: number;
  /** RGBA, non-premultiplied, row-major. */
  pixels: Uint8ClampedArray;
}

export interface RenderRequest {
  docId: number;
  pageIndex: number;
  /** Device pixels per PDF point. */
  scale: number;
  rotation: ViewRotation;
  /** Optional sub-rectangle in device pixels of the rotated, scaled page. */
  region?: Rect;
}

/**
 * Page text in reading order. Each character (including synthetic "\n" between lines)
 * has a quad in page space and a line number; this powers selection, copy and search highlights.
 */
export interface TextLayer {
  text: string;
  /** 8 numbers per character: ul, ur, ll, lr corners (x, y). */
  quads: Float32Array;
  /** Line index per character. */
  lines: Int32Array;
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchHit {
  page: number;
  /** Character offsets into the page's TextLayer text. */
  start: number;
  end: number;
  /** One rectangle per line the hit spans, page space. */
  rects: Rect[];
  /** Short text around the hit, for the results list. */
  before: string;
  match: string;
  after: string;
}

export interface LinkInfo {
  rect: Rect;
  /** External URL (http, mailto, file…), or null for internal links. */
  uri: string | null;
  /** Internal destination. */
  dest: { page: number; y: number | null } | null;
}

export interface OutlineNode {
  title: string;
  dest: { page: number; y: number | null } | null;
  uri: string | null;
  open: boolean;
  children: OutlineNode[];
}

export interface AttachmentInfo {
  name: string;
  size: number | null;
  mimeType: string | null;
  modified: string | null;
}

export interface LayerInfo {
  index: number;
  name: string;
  visible: boolean;
}

export interface AnnotationInfo {
  page: number;
  type: string;
  contents: string;
  author: string;
  modified: string | null;
  rect: Rect;
}

export interface FontInfo {
  name: string;
  type: string;
  embedded: boolean;
}

export interface DocProperties {
  metadata: Record<string, string>;
  format: string | null;
  encryption: string | null;
  language: string | null;
  pageCount: number;
  firstPageSize: PageSize | null;
  fonts: FontInfo[];
  fontsTruncated: boolean;
  permissions: Record<Permission, boolean>;
  repaired: boolean;
}
