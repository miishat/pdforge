import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";
import { luhn } from "../../src/core/redact";
import { quadsFromRects } from "../../src/core/editing";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
function open(bytes = fixture("redact.pdf")) {
  const engine = new PdfEngine();
  const r = engine.open(bytes);
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}
const textOf = (bytes: Uint8Array) => {
  const d = mupdf.Document.openDocument(bytes, "application/pdf");
  return Array.from({ length: d.countPages() }, (_, i) => d.loadPage(i).toStructuredText("").asText()).join("\n");
};
const opts = { images: "pixels" as const, lineArt: false, blackBoxes: true };

describe("redaction", () => {
  it("finds personal data with the presets", () => {
    const { engine, docId } = open();
    const find = (preset: string) => engine.findForRedaction(docId, { preset }).map((h) => h.match);
    expect(find("email")).toEqual(["jane.doe@example.com"]);
    expect(find("ssn")).toEqual(["123-45-6789"]);
    // Only the number that passes the Luhn check is a card number.
    expect(find("card")).toEqual(["4111 1111 1111 1111"]);
    expect(find("phone")).toEqual(["+1 (555) 123-4567"]);
    expect(engine.findForRedaction(docId, { text: "bluebird" })).toHaveLength(2);
  });

  it("removes marked text for good: it is gone from the saved file, not just covered", async () => {
    const { engine, docId } = open();
    const hits = engine.findForRedaction(docId, { text: "BLUEBIRD", caseSensitive: true });
    engine.markForRedaction(docId, hits.map((h) => ({ page: h.page, quads: quadsFromRects(h.rects) })));
    expect(engine.redactionMarkCount(docId)).toBe(2);
    // Marks alone don't remove anything.
    expect(engine.pageText(docId, 1)).toContain("BLUEBIRD");
    engine.applyRedactions(docId, opts);
    expect(engine.redactionMarkCount(docId)).toBe(0);
    expect(engine.pageText(docId, 0)).not.toContain("BLUEBIRD");
    expect(engine.pageText(docId, 0)).toContain("Secret project codename");
    const saved = engine.save(docId);
    expect(textOf(saved)).not.toContain("BLUEBIRD");
    // The redacted word isn't anywhere in the raw bytes either (no old revision kept).
    const raw = Buffer.from(mupdf.Document.openDocument(saved, "application/pdf").asPDF()!.saveToBuffer("decompress").asUint8Array()).toString("latin1");
    expect(raw).not.toContain("BLUEBIRD");
    expect(Buffer.from(saved).indexOf("%%EOF")).toBe(Buffer.from(saved).lastIndexOf("%%EOF"));
  });

  it("blanks image pixels under an area mark", () => {
    const { engine, docId } = open();
    // The grey image sits at PDF (72,300)-(272,500) → page space y 292..492.
    const before = engine.render({ docId, pageIndex: 0, scale: 1, rotation: 0, region: [100, 350, 110, 360] });
    expect(before.pixels[0]).toBe(128);
    engine.markForRedaction(docId, [{ page: 0, rect: [90, 330, 200, 420] }]);
    engine.applyRedactions(docId, { images: "pixels", lineArt: false, blackBoxes: false });
    const after = engine.render({ docId, pageIndex: 0, scale: 1, rotation: 0, region: [100, 350, 110, 360] });
    expect(after.pixels[0]).not.toBe(128);
    const outside = engine.render({ docId, pageIndex: 0, scale: 1, rotation: 0, region: [250, 450, 260, 460] });
    expect(outside.pixels[0]).toBe(128);
  });

  it("can be undone before saving", () => {
    const { engine, docId } = open();
    const hits = engine.findForRedaction(docId, { preset: "ssn" });
    engine.markForRedaction(docId, hits.map((h) => ({ page: h.page, quads: quadsFromRects(h.rects) })));
    engine.applyRedactions(docId, opts);
    expect(engine.pageText(docId, 0)).not.toContain("123-45-6789");
    engine.undo(docId);
    expect(engine.pageText(docId, 0)).toContain("123-45-6789");
  });

  it("checks card numbers with the Luhn algorithm", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    expect(luhn("1234")).toBe(false);
  });
});

describe("sanitise", () => {
  it("removes metadata, scripts, attachments, private data and comments", () => {
    const { engine, docId } = open();
    engine.createAnnotation(docId, 0, { author: "Jane", type: "Text", point: [10, 10], contents: "internal note" });
    const { report } = engine.sanitize(docId, { metadata: true, javascript: true, attachments: true, comments: true, thumbnails: true, privateData: true });
    expect(report.javascript).toBeGreaterThan(0);
    expect(report.attachments).toBe(1);
    expect(report.comments).toBe(1);
    expect(report.privateData).toBe(1);
    expect(report.metadata).toBeGreaterThan(0);
    const saved = engine.save(docId);
    const raw = Buffer.from(saved).toString("latin1");
    for (const secret of ["Jane Doe", "app.alert", "hidden attachment", "secret app data", "internal note"]) expect(raw).not.toContain(secret);
    expect(textOf(saved)).toContain("Customer record");
  });
});

describe("finding text to redact in large documents", () => {
  it("finds every match, well past 5,000, in batches or all at once alike, each with its position", () => {
    const engine = new PdfEngine();
    const r = engine.open(new Uint8Array(readFileSync(new URL("../fixtures/long-600.pdf", import.meta.url))));
    if (r.status !== "ok") throw new Error("expected ok");
    const id = r.info.docId;
    const query = { text: "[a-z]", regex: true };
    const all = engine.findForRedaction(id, query);
    expect(all.length).toBeGreaterThan(5000);
    expect(all.every((h) => h.rects.length > 0)).toBe(true);
    const batched = [];
    for (let p = 0; p < 600; ) {
      const b = engine.findForRedactionBatch(id, query, p, 0); // a zero budget: one page per call
      expect(b.next).toBe(p + 1);
      batched.push(...b.hits);
      p = b.next;
    }
    expect(batched.map((h) => `${h.page}:${h.start}`)).toEqual(all.map((h) => `${h.page}:${h.start}`));
  });
});
