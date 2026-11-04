import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PdfEngine } from "../../src/core/engine";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

describe("PdfEngine", () => {
  it("opens a PDF and reports pages and metadata", () => {
    const engine = new PdfEngine();
    const result = engine.open(fixture("sample.pdf"));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.info.pageCount).toBe(5);
    expect(result.info.title).toBe("PDForge Sample");
    expect(result.info.pages[0]).toEqual({ width: 612, height: 792 });
    expect(result.info.pages[2]).toEqual({ width: 792, height: 612 });
  });

  it("renders a page to RGBA pixels at the requested scale", () => {
    const engine = new PdfEngine();
    const result = engine.open(fixture("sample.pdf"));
    if (result.status !== "ok") throw new Error("expected ok");
    const page = engine.render(result.info.docId, 0, 0.5);
    expect(page.width).toBe(306);
    expect(page.height).toBe(396);
    expect(page.pixels.length).toBe(306 * 396 * 4);
    // Corner is white paper; somewhere there must be dark text.
    expect([...page.pixels.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    let dark = 0;
    for (let i = 0; i < page.pixels.length; i += 4) if (page.pixels[i] < 100) dark++;
    expect(dark).toBeGreaterThan(50);
  });

  it("asks for a password and rejects a wrong one", () => {
    const engine = new PdfEngine();
    const result = engine.open(fixture("encrypted.pdf"));
    expect(result.status).toBe("needs-password");
    if (result.status !== "needs-password") return;
    expect(() => engine.unlock(result.docId, "nope")).toThrow(/password/);
    expect(engine.unlock(result.docId, "secret").pageCount).toBe(1);
  });

  it("rejects files that are not PDFs with a readable message", () => {
    const engine = new PdfEngine();
    expect(() => engine.open(new TextEncoder().encode("hello, not a pdf"))).toThrow(/couldn't be opened/);
  });

  it("reads page sizes of a 300-page document quickly", () => {
    const engine = new PdfEngine();
    const t0 = performance.now();
    const result = engine.open(fixture("long-300.pdf"));
    const ms = performance.now() - t0;
    expect(result.status === "ok" && result.info.pageCount).toBe(300);
    expect(ms).toBeLessThan(1500);
  });
});
