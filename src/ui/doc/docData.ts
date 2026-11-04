// Per-document caches of data fetched from the engine (text layers, links), shared by all views of a tab.
import { engine } from "../../core/client";
import type { LinkInfo, TextLayer } from "../../core/types";

export class DocData {
  private text = new Map<number, Promise<TextLayer>>();
  private textReady = new Map<number, TextLayer>();
  private links = new Map<number, Promise<LinkInfo[]>>();

  constructor(readonly docId: number) {}

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
}
