// Per-document caches of data fetched from the engine (text layers, links, annotations, form fields),
// shared by all views of a tab. Edits invalidate the affected pages.
import { useSyncExternalStore } from "react";
import { engine } from "../../core/client";
import type { AnnotationInfo, LinkInfo, TextLayer } from "../../core/types";
import type { WidgetInfo } from "../../core/forms";

export class DocData {
  private text = new Map<number, Promise<TextLayer>>();
  private textReady = new Map<number, TextLayer>();
  private links = new Map<number, Promise<LinkInfo[]>>();
  private annots = new Map<number, Promise<AnnotationInfo[]>>();
  private annotsReady = new Map<number, AnnotationInfo[]>();
  private widgets = new Map<number, Promise<WidgetInfo[]>>();
  private widgetsReady = new Map<number, WidgetInfo[]>();
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

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  textLayer(page: number): Promise<TextLayer> {
    let p = this.text.get(page);
    if (!p) {
      p = engine().call("textLayer", this.docId, page);
      p.then((l) => this.textReady.set(page, l)).catch(() => this.text.delete(page));
      this.text.set(page, p);
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
      p.catch(() => this.links.delete(page));
      this.links.set(page, p);
    }
    return p;
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
      if (opts.text) {
        this.text.clear();
        this.textReady.clear();
        this.links.clear();
      }
      this.globalVersion++;
    } else {
      for (const p of pages) {
        this.annots.delete(p);
        this.widgets.delete(p);
        this.pageVersions.set(p, (this.pageVersions.get(p) ?? 0) + 1);
        // Keep the stale lists until fresh ones arrive, so overlays don't flicker.
        void this.pageAnnots(p);
        void this.pageWidgets(p);
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
