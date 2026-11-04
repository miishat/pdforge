import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
function open(name = "sample.pdf") {
  const engine = new PdfEngine();
  const r = engine.open(fixture(name));
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}
const firstLines = (e: PdfEngine, id: number) => Array.from({ length: e.info(id).pageCount }, (_, i) => e.pageText(id, i).split("\n")[0]);
const titles = ["PDForge sample document", "Second page", "Landscape page", "A5 page", "Last page"];

describe("page organisation", () => {
  it("moves, deletes and duplicates pages, each undoable", () => {
    const { engine, docId } = open();
    engine.movePages(docId, [4], 0);
    expect(firstLines(engine, docId)).toEqual(["Last page", ...titles.slice(0, 4)]);
    engine.movePages(docId, [0, 1], 5);
    expect(firstLines(engine, docId)).toEqual([...titles.slice(1, 4), "Last page", titles[0]]);
    engine.undo(docId);
    engine.undo(docId);
    expect(firstLines(engine, docId)).toEqual(titles);
    engine.deletePages(docId, [1, 3]);
    expect(firstLines(engine, docId)).toEqual([titles[0], titles[2], titles[4]]);
    expect(() => engine.deletePages(docId, [0, 1, 2])).toThrow(/at least one page/);
    engine.duplicatePages(docId, [0]);
    expect(firstLines(engine, docId)).toEqual([titles[0], titles[0], titles[2], titles[4]]);
    // Duplicates are independent page objects.
    engine.rotatePages(docId, [1], 90);
    const info = engine.info(docId);
    expect(info.pages[0]).toEqual({ width: 612, height: 792 });
    expect(info.pages[1]).toEqual({ width: 792, height: 612 });
  });

  it("rotates pages by quarter turns", () => {
    const { engine, docId } = open();
    engine.rotatePages(docId, [0, 3], 90);
    engine.rotatePages(docId, [0], 90);
    const p = engine.info(docId).pages;
    expect(p[0]).toEqual({ width: 612, height: 792 });
    expect(p[3]).toEqual({ width: 595, height: 420 });
  });

  it("inserts blank pages, pages from another file and images", () => {
    const { engine, docId } = open();
    engine.insertBlankPage(docId, 1, [595, 842]);
    expect(engine.info(docId).pages[1]).toEqual({ width: 595, height: 842 });
    const r = engine.insertPagesFrom(docId, 0, fixture("features.pdf"), [2]);
    expect(r.inserted).toBe(1);
    expect(engine.pageText(docId, 0)).toContain("Chapter 2: Rivers");
    const png = engine.renderImage({ docId, pageIndex: 2, scale: 0.5, rotation: 0 }, "png");
    engine.insertImagePage(docId, engine.info(docId).pageCount, png);
    expect(engine.info(docId).pageCount).toBe(8);
    expect(() => engine.insertPagesFrom(docId, 0, fixture("encrypted.pdf"))).toThrow(/password/);
    expect(engine.insertPagesFrom(docId, 0, fixture("encrypted.pdf"), undefined, "secret").inserted).toBe(1);
  });

  it("replaces pages with pages from another file", () => {
    const { engine, docId } = open();
    engine.replacePages(docId, [1, 2], fixture("features.pdf"), [1, 2]);
    expect(firstLines(engine, docId)).toEqual([titles[0], "Chapter 1: Mountains", "Chapter 2: Rivers", titles[3], titles[4]]);
    expect(() => engine.replacePages(docId, [0], fixture("features.pdf"), [0, 1])).toThrow(/Choose 1 page/);
  });

  it("extracts and splits into separate files", () => {
    const { engine, docId } = open();
    const ex = mupdf.Document.openDocument(engine.extractPages(docId, [4, 0]), "application/pdf");
    expect(ex.countPages()).toBe(2);
    expect(ex.loadPage(0).toStructuredText("").asText()).toContain("Last page");
    const parts = engine.splitDocument(docId, { kind: "every", n: 2 });
    expect(parts.map((p) => [p.label, mupdf.Document.openDocument(p.bytes, "application/pdf").countPages()])).toEqual([
      ["pages 1-2", 2], ["pages 3-4", 2], ["pages 5-5", 1],
    ]);
    const byRanges = engine.splitDocument(docId, { kind: "ranges", ranges: [[0], [1, 2, 3]] });
    expect(byRanges.map((p) => p.label)).toEqual(["page 1", "pages 2-4"]);
    expect(() => engine.splitDocument(docId, { kind: "bookmarks" })).toThrow(/no bookmarks/);
    const f = open("features.pdf");
    expect(f.engine.splitDocument(f.docId, { kind: "bookmarks" }).map((p) => p.label)).toEqual(["Contents", "Chapter 1 Mountains", "Chapter 2 Rivers"]);
  });

  it("merges files with a bookmark per file", () => {
    const { engine } = open();
    const merged = engine.mergeFiles([{ name: "sample.pdf", bytes: fixture("sample.pdf") }, { name: "features.pdf", bytes: fixture("features.pdf") }], true);
    const d = mupdf.Document.openDocument(merged, "application/pdf");
    expect(d.countPages()).toBe(8);
    expect(d.loadOutline()!.map((o) => [o.title, o.page])).toEqual([["sample", 0], ["features", 5]]);
    expect(() => engine.mergeFiles([{ name: "x.pdf", bytes: fixture("encrypted.pdf") }], false)).toThrow(/password-protected/);
  });

  it("crops by margins and to content, and resizes pages", () => {
    const { engine, docId } = open();
    engine.cropPages(docId, [0], { top: 36, right: 72, bottom: 36, left: 72 });
    expect(engine.info(docId).pages[0]).toEqual({ width: 468, height: 720 });
    expect(() => engine.cropPages(docId, [1], { top: 400, right: 0, bottom: 400, left: 0 })).toThrow(/almost nothing/);
    engine.cropToContent(docId, [1]);
    const c = engine.info(docId).pages[1];
    expect(c.width).toBeLessThan(612);
    expect(c.height).toBeLessThan(792);
    engine.resizePages(docId, [3], [595, 842], true);
    expect(engine.info(docId).pages[3]).toEqual({ width: 595, height: 842 });
    // The content is still there, scaled up.
    expect(engine.pageText(docId, 3)).toContain("A5 page");
  });
});
