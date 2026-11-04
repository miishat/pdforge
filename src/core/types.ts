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
  /** MuPDF had to rebuild the file's structure to read it (it was damaged). */
  repaired: boolean;
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

export type Point = [number, number];
export type Color = [number, number, number];

export interface AnnotationInfo {
  /** PDF object number; stable for the life of the open document. */
  id: number;
  page: number;
  type: string;
  /** Bounds in page space. */
  rect: Rect;
  contents: string;
  author: string;
  subject: string;
  modified: string | null;
  created: string | null;
  color: Color | null;
  interiorColor: Color | null;
  opacity: number;
  borderWidth: number;
  /** Object number of the annotation this one replies to (comment threads). */
  inReplyTo: number | null;
  /** Review state for state-only replies: Accepted, Rejected, Cancelled, Completed, None. */
  state: string | null;
  icon: string | null;
  intent: string | null;
  lineEndings: [string, string] | null;
  fontSize: number | null;
  /** Hidden or reply annotations aren't drawn on the page. */
  hidden: boolean;
  /** Rectangle-based annotations can be resized by their corners. */
  resizable: boolean;
}

export type MarkupType = "Highlight" | "Underline" | "StrikeOut" | "Squiggly";

export type NewAnnotation = AnnotationStyle & { author: string; contents?: string; subject?: string } & (
    | { type: MarkupType; quads: Quad[] }
    | { type: "Text"; point: Point; icon?: string }
    | { type: "FreeText"; rect: Rect; fontSize: number; callout?: Point[] }
    | { type: "Square" | "Circle"; rect: Rect }
    | { type: "Line"; line: [Point, Point]; endings?: [string, string]; intent?: "LineArrow" | "LineDimension"; caption?: boolean; measure?: MeasureScale }
    | { type: "Polygon" | "PolyLine"; vertices: Point[]; intent?: "PolygonDimension" | "PolyLineDimension"; measure?: MeasureScale }
    | { type: "Ink"; strokes: Point[][] }
    | { type: "Stamp"; rect: Rect; icon?: string; image?: Uint8Array }
  );

export interface AnnotationStyle {
  color?: Color;
  interiorColor?: Color | null;
  opacity?: number;
  borderWidth?: number;
}

/** How many real-world units one PDF point represents, for measurement annotations. */
export interface MeasureScale {
  /** Real-world units per PDF inch (72 pt). */
  ratio: number;
  unit: string;
}

export interface AnnotationPatch extends AnnotationStyle {
  rect?: Rect;
  translate?: Point;
  contents?: string;
  fontSize?: number;
  lineEndings?: [string, string];
  author?: string;
}

/** Pages whose rendering changed; null means "any page" (after undo/redo). */
export interface EditResult {
  pages: number[] | null;
  id?: number;
}

export interface EditState {
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
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
