import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PdfEngine, formatPdfDate } from "../../src/core/engine";
import { rectsForRange, textForRange } from "../../src/core/textlayer";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const opts = { caseSensitive: false, wholeWord: false, regex: false };

let engine: PdfEngine;
let docId: number;

beforeAll(() => {
  engine = new PdfEngine();
  const r = engine.open(fixture("features.pdf"));
  if (r.status !== "ok") throw new Error("expected ok");
  docId = r.info.docId;
});

describe("text layer", () => {
  it("extracts text in reading order with a quad per character", () => {
    const layer = engine.textLayer(docId, 1);
    expect(layer.text).toContain("Chapter 1: Mountains\n");
    expect(layer.quads.length).toBe(layer.text.length * 8);
    expect(layer.lines.length).toBe(layer.text.length);
  });

  it("gives one rectangle per line for a multi-line range", () => {
    const layer = engine.textLayer(docId, 1);
    const start = layer.text.indexOf("Mountains are");
    const end = layer.text.indexOf("sentence.") + "sentence.".length;
    expect(rectsForRange(layer, start, end)).toHaveLength(2);
    expect(textForRange(layer, start, end)).toBe("Mountains are tall. The aurora is visible from the summit.\nCopy this sentence.");
  });
});

describe("search", () => {
  it("finds case-insensitive matches across the document", () => {
    const hits = engine.search(docId, "aurora", opts, 0, 3);
    // "aurora" ×1 p1, ×1 p2, "Aurora", "AURORA", "auroras" on p3
    expect(hits.map((h) => h.page)).toEqual([0, 1, 2, 2, 2]);
    expect(hits[0].rects).toHaveLength(1);
    expect(hits[1].before).toContain("The ");
  });

  it("honours case-sensitive and whole-word options", () => {
    expect(engine.search(docId, "AURORA", { ...opts, caseSensitive: true }, 0, 3)).toHaveLength(1);
    expect(engine.search(docId, "aurora", { ...opts, wholeWord: true }, 0, 3)).toHaveLength(4);
  });

  it("supports regular expressions and rejects invalid ones", () => {
    expect(engine.search(docId, "Chapter \\d", { ...opts, regex: true }, 0, 3)).toHaveLength(2);
    expect(() => engine.search(docId, "([", { ...opts, regex: true }, 0, 3)).toThrow(/isn't valid/);
  });

  it("searches only the requested page range", () => {
    expect(engine.search(docId, "aurora", opts, 2, 3).every((h) => h.page === 2)).toBe(true);
  });
});

describe("navigation data", () => {
  it("reads the outline with resolved destinations", () => {
    const outline = engine.outline(docId);
    expect(outline.map((o) => o.title)).toEqual(["Contents", "Chapter 1: Mountains", "Chapter 2: Rivers"]);
    expect(outline[2].dest?.page).toBe(2);
  });

  it("reads internal and external links", () => {
    const links = engine.links(docId, 0);
    expect(links).toHaveLength(2);
    expect(links[0].dest?.page).toBe(2);
    expect(links[1].uri).toBe("https://example.com/");
  });
});

describe("attachments, annotations, layers, properties", () => {
  it("lists and extracts attachments", () => {
    const list = engine.attachments(docId);
    expect(list.map((a) => a.name)).toEqual(["notes.txt"]);
    expect(new TextDecoder().decode(engine.attachment(docId, "notes.txt"))).toBe("Attached notes for PDForge tests.");
    expect(() => engine.attachment(docId, "missing.txt")).toThrow(/couldn't be found/);
  });

  it("lists comments with author and contents, skipping links", () => {
    const annots = engine.annotations(docId);
    expect(annots.map((a) => a.type).sort()).toEqual(["Highlight", "Text"]);
    expect(annots.find((a) => a.type === "Text")?.contents).toBe("Check the summit height.");
    expect(annots.every((a) => a.page === 1 && a.author === "Reviewer")).toBe(true);
  });

  it("reports no layers for a document without optional content", () => {
    expect(engine.layers(docId)).toEqual([]);
  });

  it("collects properties including fonts and permissions", () => {
    const props = engine.properties(docId);
    expect(props.metadata.Title).toBe("PDForge Features");
    expect(props.metadata.Subject).toBe("Phase 1 test document");
    expect(props.format).toBe("PDF 1.7");
    expect(props.fonts).toEqual([{ name: "Helvetica", type: "Type1", embedded: false }]);
    expect(props.permissions.print).toBe(true);
    expect(props.pageCount).toBe(3);
  });

  it("formats PDF dates", () => {
    expect(formatPdfDate("D:20240131120500+01'00'")).toBe("2024-01-31 12:05");
    expect(formatPdfDate("D:2024")).toBe("2024-01-01");
    expect(formatPdfDate("yesterday")).toBe("yesterday");
  });
});

describe("rendering", () => {
  it("rotates the view by swapping dimensions", () => {
    const page = engine.render({ docId, pageIndex: 0, scale: 0.25, rotation: 90 });
    expect(page.width).toBe(198);
    expect(page.height).toBe(153);
  });

  it("renders a region identical to the same area of a full render", () => {
    const full = engine.render({ docId, pageIndex: 1, scale: 1, rotation: 0 });
    const region = engine.render({ docId, pageIndex: 1, scale: 1, rotation: 0, region: [60, 40, 260, 140] });
    expect(region.width).toBe(200);
    expect(region.height).toBe(100);
    let diff = 0;
    for (let y = 0; y < 100; y += 7)
      for (let x = 0; x < 200; x += 7) {
        const a = ((y + 40) * full.width + (x + 60)) * 4;
        const b = (y * 200 + x) * 4;
        diff += Math.abs(full.pixels[a] - region.pixels[b]);
      }
    expect(diff / ((100 / 7) * (200 / 7))).toBeLessThan(2);
  });

  it("encodes PNG snapshots", () => {
    const png = engine.renderImage({ docId, pageIndex: 0, scale: 0.5, rotation: 0, region: [0, 0, 100, 50] });
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  });
});
