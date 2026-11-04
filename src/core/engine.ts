// PDF engine: a thin, DOM-free layer over MuPDF. Runs in a Web Worker in the app
// and directly in Node for tests (and, later, the CLI).
import * as mupdf from "mupdf";
import type { DocInfo, OpenResult, RenderedPage } from "./types";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: "not-found" | "bad-password" | "invalid-file" | "bad-page",
  ) {
    super(message);
  }
}

interface OpenDoc {
  doc: mupdf.Document;
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
    this.docs.set(docId, { doc });
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
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      pages.push({ width: x1 - x0, height: y1 - y0 });
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
    };
  }

  /** Renders a page at `scale` device pixels per PDF point. */
  render(docId: number, pageIndex: number, scale: number): RenderedPage {
    const { doc } = this.get(docId);
    if (pageIndex < 0 || pageIndex >= doc.countPages()) {
      throw new EngineError(`Page ${pageIndex + 1} doesn't exist.`, "bad-page");
    }
    const page = doc.loadPage(pageIndex);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
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
      return { width, height, pixels: rgba };
    } finally {
      pix.destroy();
      page.destroy();
    }
  }

  close(docId: number): void {
    const entry = this.docs.get(docId);
    if (entry) {
      entry.doc.destroy();
      this.docs.delete(docId);
    }
  }

  private get(docId: number): OpenDoc {
    const entry = this.docs.get(docId);
    if (!entry) throw new EngineError("That document is no longer open.", "not-found");
    return entry;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
