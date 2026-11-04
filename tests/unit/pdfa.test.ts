import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
function open(bytes: Uint8Array) {
  const engine = new PdfEngine();
  const r = engine.open(bytes);
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}
const status = (report: { checks: { id: string; status: string }[] }, id: string) => report.checks.find((c) => c.id === id)?.status;

describe("PDF/A", () => {
  it("reports what an ordinary PDF is missing", () => {
    const { engine, docId } = open(fixture("features.pdf"));
    const r = engine.checkPdfA(docId);
    expect(r.ok).toBe(false);
    expect(r.claims).toBeNull();
    expect(status(r, "fonts")).toBe("fail");
    expect(status(r, "intent")).toBe("fail");
    expect(status(r, "metadata")).toBe("fail");
    expect(status(r, "encryption")).toBe("pass");
  });

  it("converts to PDF/A-2b: fonts embedded, sRGB intent, XMP identification", () => {
    const { engine, docId } = open(fixture("features.pdf"));
    const r = engine.convertToPdfA(docId);
    expect(r.report.ok).toBe(true);
    expect(status(r.report, "fonts")).toBe("fixed");
    const bytes = engine.save(docId);
    // A fresh check of the saved file passes and sees the claim.
    const { engine: e2, docId: d2 } = open(bytes);
    const again = e2.checkPdfA(d2);
    expect(again.checks.filter((c) => c.status === "fail").map((c) => c.detail)).toEqual([]);
    expect(again.claims).toBe("PDF/A-2B");
    expect(e2.properties(d2).fonts.every((f) => f.embedded)).toBe(true);
    // Text still extracts with the substituted fonts.
    expect(e2.pageText(d2, 0)).toContain("Contents");

    const pdf = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
    const root = pdf.getTrailer().get("Root");
    const xmp = root.get("Metadata").readStream().asString();
    const producer = pdf.getTrailer().get("Info").get("Producer").asString();
    expect(xmp).toContain(`<pdf:Producer>${producer}</pdf:Producer>`);
    expect(root.get("OutputIntents").get(0).get("S").asName()).toBe("GTS_PDFA1");
    // Every annotation prints.
    for (let p = 0; p < pdf.countPages(); p++) {
      for (const a of (pdf.loadPage(p) as mupdf.PDFPage).getAnnotations()) {
        if (a.getType() !== "Popup") expect(a.getObject().get("F").asNumber() & 4).toBe(4);
      }
    }
  });

  it("is one undoable step", () => {
    const { engine, docId } = open(fixture("features.pdf"));
    engine.convertToPdfA(docId);
    engine.undo(docId);
    expect(engine.checkPdfA(docId).ok).toBe(false);
  });

  it("refuses encrypted files until security is removed", () => {
    const { engine, docId } = open(fixture("sample.pdf"));
    engine.setSecurity(docId, { userPassword: "", ownerPassword: "o", permissions: { print: true, printHigh: true, copy: true, edit: true, annotate: true, fillForms: true, assemble: true, accessibility: true } });
    const { engine: e2, docId: d2 } = open(engine.save(docId));
    const r = e2.convertToPdfA(d2);
    expect(status(r.report, "encryption")).toBe("fail");
  });
});
