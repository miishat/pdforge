import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PdfEngine } from "../../src/core/engine";
import { expandTokens } from "../../src/core/stamping";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
function open(name = "sample.pdf") {
  const engine = new PdfEngine();
  const r = engine.open(fixture(name));
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}
const all = [0, 1, 2, 3, 4];
const hf = (over: object = {}) => ({
  top: ["", "Quarterly report", ""] as [string, string, string],
  bottom: ["{file}", "", "Page {page} of {pages}"] as [string, string, string],
  fontSize: 10,
  color: [0.3, 0.3, 0.3] as [number, number, number],
  margin: 36,
  startNumber: 1,
  fileName: "sample.pdf",
  pages: all,
  ...over,
});

/** y position (page space) of the first line containing `needle`. */
function lineY(engine: PdfEngine, docId: number, page: number, needle: string): number {
  const layer = engine.textLayer(docId, page);
  const i = layer.text.indexOf(needle);
  expect(i).toBeGreaterThanOrEqual(0);
  return layer.quads[i * 8 + 1];
}

describe("page marks", () => {
  it("adds headers and footers with page numbers at the visible top and bottom", () => {
    const { engine, docId } = open();
    expect(engine.addHeaderFooter(docId, hf()).lossy).toBe(false);
    expect(engine.pageText(docId, 0)).toContain("Page 1 of 5");
    expect(engine.pageText(docId, 4)).toContain("Page 5 of 5");
    expect(lineY(engine, docId, 0, "Quarterly report")).toBeLessThan(60);
    expect(lineY(engine, docId, 0, "Page 1 of 5")).toBeGreaterThan(740);
    // Landscape page: still at its own top.
    expect(lineY(engine, docId, 2, "Quarterly report")).toBeLessThan(60);
  });

  it("follows page rotation", () => {
    const { engine, docId } = open();
    engine.rotatePages(docId, [0], 90);
    engine.addHeaderFooter(docId, hf({ pages: [0] }));
    const info = engine.info(docId).pages[0];
    expect(info.width).toBe(792);
    expect(lineY(engine, docId, 0, "Quarterly report")).toBeLessThan(60);
    expect(lineY(engine, docId, 0, "Page 1 of 5")).toBeGreaterThan(info.height - 60);
  });

  it("replaces rather than stacks, and can be removed or undone", () => {
    const { engine, docId } = open();
    engine.addHeaderFooter(docId, hf());
    engine.addHeaderFooter(docId, hf({ top: ["", "Second version", ""] }));
    const t = engine.pageText(docId, 0);
    expect(t).toContain("Second version");
    expect(t).not.toContain("Quarterly report");
    expect(engine.markKinds(docId)).toEqual(["headerfooter"]);
    expect(engine.removeMarks(docId, "headerfooter").removed).toBe(5);
    expect(engine.pageText(docId, 0)).not.toContain("Second version");
    expect(engine.pageText(docId, 0)).toContain("PDForge sample document");
    engine.undo(docId);
    expect(engine.pageText(docId, 0)).toContain("Second version");
  });

  it("numbers pages with Bates numbers from a start value", () => {
    const { engine, docId } = open();
    engine.addHeaderFooter(docId, hf({ top: ["", "", ""], bottom: ["", "", "{bates}"], bates: { prefix: "ACME-", start: 98, digits: 6, suffix: "" }, pages: [1, 2, 3] }));
    expect(engine.pageText(docId, 1)).toContain("ACME-000098");
    expect(engine.pageText(docId, 3)).toContain("ACME-000100");
    expect(engine.pageText(docId, 0)).not.toContain("ACME-");
  });

  it("reports characters Helvetica can't show", () => {
    const { engine, docId } = open();
    expect(engine.addHeaderFooter(docId, hf({ top: ["", "Prix: 12 € – café", ""] })).lossy).toBe(false);
    expect(engine.addHeaderFooter(docId, hf({ top: ["", "报告", ""] })).lossy).toBe(true);
  });

  it("adds text and image watermarks, behind or over content", () => {
    const { engine, docId } = open();
    engine.addWatermark(docId, { text: "CONFIDENTIAL", fontSize: 60, color: [0.8, 0.1, 0.1], opacity: 0.3, rotation: 45, scale: 0.5, behind: false, pages: all });
    expect(engine.pageText(docId, 0)).toContain("CONFIDENTIAL");
    // Rendered as a faint diagonal: a pixel near the centre is tinted but not opaque red.
    const px = engine.render({ docId, pageIndex: 0, scale: 0.5, rotation: 0 });
    let tinted = 0;
    for (let i = 0; i < px.pixels.length; i += 4) if (px.pixels[i] > 200 && px.pixels[i + 1] < 220 && px.pixels[i + 1] > 120) tinted++;
    expect(tinted).toBeGreaterThan(200);
    const png = engine.renderImage({ docId, pageIndex: 1, scale: 0.2, rotation: 0 }, "png");
    engine.addWatermark(docId, { image: png, fontSize: 0, color: [0, 0, 0], opacity: 0.5, rotation: 0, scale: 0.4, behind: true, pages: [1] });
    expect(engine.markKinds(docId)).toEqual(["watermark"]);
  });

  it("adds a background colour behind the content", () => {
    const { engine, docId } = open();
    engine.addBackground(docId, { color: [1, 0.95, 0.8], opacity: 1, pages: [0] });
    const px = engine.render({ docId, pageIndex: 0, scale: 0.2, rotation: 0 });
    expect([...px.pixels.slice(0, 3)]).toEqual([255, 242, 204]);
    expect(engine.pageText(docId, 0)).toContain("PDForge sample document");
  });

  it("expands tokens", () => {
    expect(expandTokens("{file} · {page}/{pages} · {bates}", { page: 3, pages: 9, date: "d", file: "f.pdf", bates: "B1" })).toBe("f.pdf · 3/9 · B1");
  });
});
