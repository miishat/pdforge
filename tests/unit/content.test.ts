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

describe("text editing", () => {
  it("lists lines with font, size and position", () => {
    const { engine, docId } = open();
    const lines = engine.textLines(docId, 0);
    expect(lines.map((l) => l.text)).toEqual(["PDForge sample document", "Page one of five.", "The quick brown fox jumps over the lazy dog."]);
    expect(lines[0]).toMatchObject({ size: 24, editable: true, serif: false });
    expect(lines[1].size).toBe(12);
  });

  it("replaces a line in place with the original font when it has the glyphs", () => {
    const { engine, docId } = open();
    const [, line] = engine.textLines(docId, 0);
    const r = engine.replaceLine(docId, 0, 1, line.text, "Page one of five (revised).");
    expect(r.substituted).toBe(false);
    const after = engine.textLines(docId, 0);
    const edited = after.find((l) => l.text.startsWith("Page one"))!;
    expect(edited.text).toBe("Page one of five (revised).");
    expect(edited.size).toBe(12);
    expect(Math.abs(edited.origin[0] - line.origin[0])).toBeLessThan(0.5);
    expect(Math.abs(edited.origin[1] - line.origin[1])).toBeLessThan(0.5);
    expect(engine.pageText(docId, 0)).not.toContain("Page one of five.\\n");
    // Nothing else moved.
    expect(after.map((l) => l.text)).toContain("The quick brown fox jumps over the lazy dog.");
    engine.undo(docId);
    expect(engine.textLines(docId, 0)[1].text).toBe("Page one of five.");
  });

  it("falls back to a standard font for characters the original doesn't have, and guards against stale edits", () => {
    const { engine, docId } = open();
    const [first] = engine.textLines(docId, 0);
    expect(() => engine.replaceLine(docId, 0, 0, "something else", "x")).toThrow(/page changed/);
    const r = engine.replaceLine(docId, 0, 0, first.text, "Résumé – 2026");
    expect(r.usedFont).toMatch(/Helvetica|Nimbus|Sans/);
    expect(engine.pageText(docId, 0)).toContain("Résumé – 2026");
  });

  it("adds new text", () => {
    const { engine, docId } = open();
    engine.addText(docId, 1, [72, 400], "Added line one\nand line two", { size: 14, color: [0.1, 0.2, 0.6], family: "serif", bold: true, italic: false });
    const t = engine.pageText(docId, 1);
    expect(t).toContain("Added line one");
    expect(t).toContain("and line two");
    const line = engine.textLines(docId, 1).find((l) => l.text === "Added line one")!;
    expect(line).toMatchObject({ size: 14, bold: true, serif: true });
  });
});

describe("image editing", () => {
  it("finds, moves, replaces and deletes images", () => {
    const { engine, docId } = open("redact.pdf");
    const imgs = engine.images(docId, 0);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].rect.map(Math.round)).toEqual([72, 292, 272, 492]);
    engine.moveImage(docId, 0, 0, [300, 500, 400, 600]);
    expect(engine.images(docId, 0)[0].rect.map(Math.round)).toEqual([300, 500, 400, 600]);
    const png = engine.renderImage({ docId, pageIndex: 1, scale: 0.2, rotation: 0 }, "png");
    engine.replaceImage(docId, 0, 0, png);
    const replaced = engine.images(docId, 0)[0];
    expect(replaced.width).not.toBe(100);
    engine.deleteImage(docId, 0, 0);
    expect(engine.images(docId, 0)).toHaveLength(0);
    // Text on the page survived all of it.
    expect(engine.pageText(docId, 0)).toContain("Customer record");
    engine.insertImage(docId, 1, [72, 300, 272, 400], png);
    expect(engine.images(docId, 1)).toHaveLength(1);
  });

  it("refuses to edit while redaction marks are pending on the page", () => {
    const { engine, docId } = open("redact.pdf");
    engine.markForRedaction(docId, [{ page: 0, rect: [72, 600, 200, 700] }]);
    expect(() => engine.deleteImage(docId, 0, 0)).toThrow(/redaction marks/);
  });
});

describe("links, bookmarks, metadata, attachments", () => {
  it("adds and deletes links", () => {
    const { engine, docId } = open();
    engine.addLink(docId, 0, [72, 100, 200, 120], { page: 3 });
    engine.addLink(docId, 0, [72, 130, 200, 150], { uri: "https://example.org/" });
    const links = engine.links(docId, 0);
    expect(links.map((l) => l.dest?.page ?? l.uri)).toEqual([3, "https://example.org/"]);
    expect(() => engine.addLink(docId, 0, [0, 0, 10, 10], { uri: "javascript:alert(1)" })).toThrow(/web pages/);
    engine.deleteLink(docId, 0, 0);
    expect(engine.links(docId, 0)).toHaveLength(1);
  });

  it("rewrites the bookmark tree", () => {
    const { engine, docId } = open();
    engine.setOutline(docId, [
      { title: "Intro", page: 0, children: [{ title: "Details", page: 1, children: [] }] },
      { title: "End", page: 4, children: [] },
    ]);
    const o = engine.outline(docId);
    expect(o.map((n) => [n.title, n.dest?.page])).toEqual([["Intro", 0], ["End", 4]]);
    expect(o[0].children.map((n) => n.title)).toEqual(["Details"]);
    engine.setOutline(docId, []);
    expect(engine.outline(docId)).toEqual([]);
  });

  it("edits metadata and attachments", () => {
    const { engine, docId } = open();
    engine.setMetadata(docId, { Title: "New title", Keywords: "a, b" });
    expect(engine.properties(docId).metadata).toMatchObject({ Title: "New title", Keywords: "a, b" });
    engine.addAttachment(docId, "data.csv", "text/csv", new TextEncoder().encode("a,b\n1,2"));
    expect(engine.attachments(docId).map((a) => a.name)).toEqual(["data.csv"]);
    engine.deleteAttachment(docId, "data.csv");
    expect(engine.attachments(docId)).toEqual([]);
    const saved = mupdf.Document.openDocument(engine.save(docId), "application/pdf");
    expect(saved.getMetaData("info:Title")).toBe("New title");
  });
});
