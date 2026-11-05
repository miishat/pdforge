import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";
import { plainPageText } from "../../src/core/plaintext";
import { hitRects } from "../../src/core/textlayer";
import { currentPath, toEdit } from "../../src/ui/doc/BookmarkEditor";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const opts = { caseSensitive: false, wholeWord: false, regex: false };

function open(name: string) {
  const engine = new PdfEngine();
  const r = engine.open(fixture(name));
  if (r.status !== "ok") throw new Error("not opened");
  return { engine, docId: r.info.docId, pages: r.info.pageCount };
}

describe("fast find", () => {
  it("finds the same hits as the full search, with rectangles from the text layer", () => {
    const { engine, docId } = open("features.pdf");
    const full = engine.search(docId, "aurora", opts, 0, 3);
    const fast = engine.find(docId, "aurora", opts, 0, 3).hits;
    expect(fast.map((h) => [h.page, h.start, h.end, h.match])).toEqual(full.map((h) => [h.page, h.start, h.end, h.match]));
    for (const [i, h] of fast.entries()) {
      expect(h.rects).toEqual([]);
      expect(hitRects(h, engine.textLayer(docId, h.page))).toEqual(full[i].rects);
    }
  });

  it("plain page text matches the text layer exactly", () => {
    for (const name of ["features.pdf", "sample.pdf", "table.pdf", "redact.pdf"]) {
      const bytes = fixture(name);
      const doc = mupdf.Document.openDocument(bytes, "application/pdf");
      const { engine, docId, pages } = open(name);
      for (let p = 0; p < pages; p++) expect(plainPageText(doc, p)).toBe(engine.textLayer(docId, p).text);
    }
  });

  it("stops after its time budget and says where to continue", () => {
    const { engine, docId, pages } = open("long-300.pdf");
    const r = engine.find(docId, "page", opts, 0, pages, 5000, 0);
    expect(r.next).toBe(1);
    expect(r.hits).toHaveLength(1);
    let p = 0;
    let n = 0;
    while (p < pages) {
      const x = engine.find(docId, "Page 2", opts, p, pages);
      n += x.hits.length;
      p = x.next;
    }
    // "Page 2", "Page 20".."Page 29", "Page 200".."Page 299".
    expect(n).toBe(1 + 10 + 100);
  });

  it("accepts text read by helpers only while the document is unchanged", () => {
    const { engine, docId, pages } = open("long-300.pdf");
    const src = engine.textSource(docId)!;
    expect(src.missing).toBe(pages);
    const doc = mupdf.Document.openDocument(src.bytes, "application/pdf");
    const texts = [10, 11, 12].map((p) => plainPageText(doc, p));
    expect(engine.seedText(docId, src.revision, 10, texts)).toBe(true);
    expect(engine.firstUnread(docId, 10, 20)).toBe(13);
    // Wrong text for the spot-checked page is refused.
    expect(engine.seedText(docId, src.revision, 20, ["not this page"])).toBe(false);
    // After an edit, older text is refused and helpers aren't offered.
    engine.rotatePages(docId, [0], 90);
    expect(engine.seedText(docId, src.revision, 30, [plainPageText(doc, 30)])).toBe(false);
    expect(engine.textSource(docId)).toBeNull();
    // With helpers off, find reads pages itself; without them, it stops at the first unread page.
    expect(engine.find(docId, "Page 41", opts, 40, 50, 10, 60, false).next).toBe(40);
    expect(engine.find(docId, "Page 41", opts, 40, 50).hits).toHaveLength(1);
  });
});

describe("current bookmark", () => {
  it("is the last bookmark starting on or before the page", () => {
    const { engine, docId } = open("chapters.pdf");
    const tree = toEdit(engine.outline(docId));
    expect(currentPath(tree, 0)).toEqual([0, 0]);
    expect(currentPath(tree, 145)).toEqual([1, 2]);
    expect(currentPath(tree, 299)).toEqual([2, 4]);
    expect(currentPath([], 3)).toBeNull();
  });
});

describe("rendering", () => {
  // Drawing straight into RGBA would be quicker, but blend modes (highlights) then come out different.
  it("draws the same pixels as MuPDF's own RGB rendering, as opaque RGBA", () => {
    for (const [name, pageIndex, rotation] of [["features.pdf", 1, 0], ["photo.pdf", 0, 90], ["form.pdf", 0, 0]] as const) {
      const { engine, docId } = open(name);
      const out = engine.render({ docId, pageIndex, scale: 1.3, rotation });
      const doc = mupdf.Document.openDocument(fixture(name), "application/pdf");
      const page = doc.loadPage(pageIndex);
      const m = mupdf.Matrix.concat(mupdf.Matrix.scale(1.3, 1.3), mupdf.Matrix.rotate(rotation));
      const ref = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true);
      expect([out.width, out.height]).toEqual([ref.getWidth(), ref.getHeight()]);
      const rgb = ref.getPixels();
      let diff = 0;
      let seeThrough = 0;
      for (let i = 0, j = 0; i < out.width * out.height; i++, j += 3) {
        if (out.pixels[i * 4] !== rgb[j] || out.pixels[i * 4 + 1] !== rgb[j + 1] || out.pixels[i * 4 + 2] !== rgb[j + 2]) diff++;
        if (out.pixels[i * 4 + 3] !== 255) seeThrough++;
      }
      expect([diff, seeThrough]).toEqual([0, 0]);
    }
  });
});
