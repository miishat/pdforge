// Shared types between the UI, the worker and the engine.

export interface PageSize {
  /** Width in PDF points (1/72 inch), after page rotation. */
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
}

export type OpenResult =
  | { status: "ok"; info: DocInfo }
  | { status: "needs-password"; docId: number };

export interface RenderedPage {
  width: number;
  height: number;
  /** RGBA, non-premultiplied, row-major. */
  pixels: Uint8ClampedArray;
}
