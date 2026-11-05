// Per-document caches of data fetched from the engine (text layers, links, annotations, form fields),
// shared by all views of a tab. Edits invalidate the affected pages.
import { useSyncExternalStore } from "react";
import { engine } from "../../core/client";
import type { AnnotationInfo, LinkInfo, TextLayer } from "../../core/types";
import type { WidgetInfo } from "../../core/forms";
import type { ImageInfo, TextLine } from "../../core/content";

/** Text layers kept per document; far more than fit on screen at once. */
const TEXT_LAYERS_KEPT = 120;

export class DocData {
  private text = new Map<number, Promise<TextLayer>>();
  private textReady = new Map<number, TextLayer>();
  private links = new Map<number, Promise<LinkInfo[]>>();
  private annots = new Map<number, Promise<AnnotationInfo[]>>();
  private annotsReady = new Map<number, AnnotationInfo[]>();
  private widgets = new Map<number, Promise<WidgetInfo[]>>();
  private widgetsReady = new Map<number, WidgetInfo[]>();
  private lines = new Map<number, Promise<TextLine[]>>();
  private linesReady = new Map<number, TextLine[]>();
  private images = new Map<number, Promise<ImageInfo[]>>();
  private imagesReady = new Map<number, ImageInfo[]>();
  private linksReady = new Map<number, LinkInfo[]>();
  private listeners = new Set<() => void>();
  /** Bumped whenever cached annotations or fields change, for subscribers. */
  version = 0;
  /** Bumped per page when its rendering changed. */
  pageVersions = new Map<number, number>();
  globalVersion = 0;

  constructor(readonly docId: number) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private pendingEmit = false;

  /**
   * Tells subscribers the cache changed. Page data arrives in many small replies while scrolling,
   * so the notifications are combined into one per frame rather than one per reply.
   */
  private emit() {
    this.version++;
    if (this.pendingEmit) return;
    this.pendingEmit = true;
    const flush = () => {
      this.pendingEmit = false;
      for (const fn of this.listeners) fn();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }

  textLayer(page: number): Promise<TextLayer> {
    let p = this.text.get(page);
    if (p) {
      // Most recently used last, so the oldest are forgotten first.
      this.text.delete(page);
      this.text.set(page, p);
      return p;
    }
    p = engine().call("textLayer", this.docId, page);
    p.then((l) => {
      if (this.text.get(page) === p) this.textReady.set(page, l);
    }).catch(() => this.text.delete(page));
    this.text.set(page, p);
    // A text layer holds the position of every character (about 100 KB for a full page), so keep only recent ones.
    while (this.text.size > TEXT_LAYERS_KEPT) {
      const oldest = this.text.keys().next().value!;
      this.text.delete(oldest);
      this.textReady.delete(oldest);
    }
    return p;
  }

  /** The text layer if it has already loaded; used for synchronous hit testing during drags. */
  textLayerNow(page: number): TextLayer | undefined {
    return this.textReady.get(page);
  }

  pageLinks(page: number): Promise<LinkInfo[]> {
    let p = this.links.get(page);
    if (!p) {
      p = engine().call("links", this.docId, page);
      p.then(
        (l) => {
          this.linksReady.set(page, l);
          this.emit();
        },
        () => this.links.delete(page),
      );
      this.links.set(page, p);
    }
    return p;
  }

  linksNow(page: number): LinkInfo[] | undefined {
    return this.linksReady.get(page);
  }

  /** Editable text lines (Edit mode). */
  pageLines(page: number): Promise<TextLine[]> {
    let p = this.lines.get(page);
    if (!p) {
      p = engine().call("textLines", this.docId, page);
      p.then(
        (l) => {
          this.linesReady.set(page, l);
          this.emit();
        },
        () => this.lines.delete(page),
      );
      this.lines.set(page, p);
    }
    return p;
  }

  linesNow(page: number): TextLine[] | undefined {
    return this.linesReady.get(page);
  }

  pageImages(page: number): Promise<ImageInfo[]> {
    let p = this.images.get(page);
    if (!p) {
      p = engine().call("images", this.docId, page);
      p.then(
        (l) => {
          this.imagesReady.set(page, l);
          this.emit();
        },
        () => this.images.delete(page),
      );
      this.images.set(page, p);
    }
    return p;
  }

  imagesNow(page: number): ImageInfo[] | undefined {
    return this.imagesReady.get(page);
  }

  pageAnnots(page: number): Promise<AnnotationInfo[]> {
    let p = this.annots.get(page);
    if (!p) {
      p = engine().call("annotations", this.docId, [page]);
      p.then(
        (a) => {
          this.annotsReady.set(page, a);
          this.emit();
        },
        () => this.annots.delete(page),
      );
      this.annots.set(page, p);
    }
    return p;
  }

  annotsNow(page: number): AnnotationInfo[] | undefined {
    return this.annotsReady.get(page);
  }

  pageWidgets(page: number): Promise<WidgetInfo[]> {
    let p = this.widgets.get(page);
    if (!p) {
      p = engine().call("widgets", this.docId, page);
      p.then(
        (w) => {
          this.widgetsReady.set(page, w);
          this.emit();
        },
        () => this.widgets.delete(page),
      );
      this.widgets.set(page, p);
    }
    return p;
  }

  widgetsNow(page: number): WidgetInfo[] | undefined {
    return this.widgetsReady.get(page);
  }

  /** Forget cached data for the given pages (all when null) after an edit; re-renders follow. */
  invalidate(pages: number[] | null, opts: { text?: boolean } = {}) {
    if (pages === null) {
      this.annots.clear();
      this.annotsReady.clear();
      this.widgets.clear();
      this.widgetsReady.clear();
      this.lines.clear();
      this.linesReady.clear();
      this.images.clear();
      this.imagesReady.clear();
      this.links.clear();
      this.linksReady.clear();
      if (opts.text) {
        this.text.clear();
        this.textReady.clear();
      }
      this.globalVersion++;
    } else {
      for (const p of pages) {
        this.annots.delete(p);
        this.widgets.delete(p);
        this.lines.delete(p);
        this.images.delete(p);
        this.links.delete(p);
        if (opts.text) {
          this.text.delete(p);
          this.textReady.delete(p);
        }
        this.pageVersions.set(p, (this.pageVersions.get(p) ?? 0) + 1);
        // Keep the stale lists until fresh ones arrive, so overlays don't flicker.
        void this.pageAnnots(p);
        void this.pageWidgets(p);
        if (this.linesReady.has(p)) void this.pageLines(p);
        if (this.imagesReady.has(p)) void this.pageImages(p);
        void this.pageLinks(p);
      }
    }
    this.emit();
  }

  renderKey(page: number): number {
    return this.globalVersion * 100_000 + (this.pageVersions.get(page) ?? 0);
  }
}

/** Re-renders the component whenever the document's cached data changes. */
export function useDocData(data: DocData): number {
  return useSyncExternalStore(data.subscribe, () => data.version);
}
