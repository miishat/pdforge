import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as mupdf from "mupdf";
import { createWorker, type Worker } from "tesseract.js";
import { PdfEngine } from "../../src/core/engine";

const require = createRequire(import.meta.url);
const langPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

/** A "scan" of the sample's first page: an image-only PDF, optionally skewed by `degrees`. */
function scanned(degrees = 0): Uint8Array {
  const src = mupdf.Document.openDocument(fixture("sample.pdf"), "application/pdf");
  const page = src.loadPage(0);
  const dpi = 200;
  const s = dpi / 72;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, Math.round(612 * s), Math.round(792 * s)], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const turn = mupdf.Matrix.concat(
    mupdf.Matrix.concat(mupdf.Matrix.translate(-306, -396), mupdf.Matrix.rotate(degrees)),
    mupdf.Matrix.translate(306, 396),
  );
  page.run(dev, mupdf.Matrix.concat(turn, mupdf.Matrix.scale(s, s)));
  dev.close();
  const out = new mupdf.PDFDocument();
  const res = out.addObject({ XObject: { Scan: out.addImage(new mupdf.Image(pix)) } });
  out.insertPage(-1, out.addPage([0, 0, 612, 792], 0, res, "q 612 0 0 792 0 0 cm /Scan Do Q"));
  return out.saveToBuffer("compress").asUint8Array().slice();
}

function open(bytes: Uint8Array) {
  const engine = new PdfEngine();
  const r = engine.open(bytes);
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}

let worker: Worker;
beforeAll(async () => {
  worker = await createWorker("eng", 1, { langPath, cacheMethod: "none", gzip: true });
}, 60_000);
afterAll(async () => {
  await worker?.terminate();
});

async function recognise(png: Uint8Array, deskew: boolean) {
  const { data } = await worker.recognize(Buffer.from(png), { rotateAuto: deskew, pdfTextOnly: true }, { pdf: true, text: true });
  return { pdf: new Uint8Array(data.pdf!), rotateRadians: data.rotateRadians ?? 0, text: data.text };
}

describe("OCR", () => {
  it("makes a scanned page searchable, with text where the words are", async () => {
    const { engine, docId } = open(scanned());
    expect(engine.ocrCandidates(docId, [0], false).todo).toEqual([0]);
    const r = await recognise(engine.ocrImage(docId, 0, 300), false);
    engine.addOcrLayers(docId, [{ page: 0, pdf: r.pdf }]);
    expect(engine.pageText(docId, 0)).toMatch(/quick brown fox/);
    // The recognised words sit over the printed ones (the sample's title is at y≈52–76).
    const hits = engine.search(docId, "sample", { caseSensitive: false, wholeWord: false, regex: false }, 0, 1);
    expect(hits).toHaveLength(1);
    const [, y0, , y1] = hits[0].rects[0];
    expect(y0).toBeGreaterThan(40);
    expect(y1).toBeLessThan(90);
    // The layer is invisible: the page looks the same as before.
    const saved = engine.save(docId);
    expect(mupdf.Document.openDocument(saved, "application/pdf").loadPage(0).toStructuredText("").asText()).toMatch(/quick brown fox/);
    // Pages with text are skipped unless forced; our own layer can be redone.
    expect(engine.ocrCandidates(docId, [0], false).todo).toEqual([0]);
    const { engine: e2, docId: d2 } = open(fixture("sample.pdf"));
    expect(e2.ocrCandidates(d2, [0, 1], false)).toEqual({ todo: [], skipped: [0, 1] });
  }, 60_000);

  it("straightens a skewed scan so it lines up with the text", async () => {
    const { engine, docId } = open(scanned(2.5));
    const r = await recognise(engine.ocrImage(docId, 0, 300), true);
    expect(Math.abs(r.rotateRadians)).toBeGreaterThan(0.03);
    engine.addOcrLayers(docId, [{ page: 0, pdf: r.pdf, rotateRadians: r.rotateRadians, deskew: true }]);
    expect(engine.pageText(docId, 0)).toMatch(/quick brown fox/);
    // After straightening, Tesseract finds (almost) no skew left.
    const again = await recognise(engine.ocrImage(docId, 0, 300), true);
    expect(Math.abs(again.rotateRadians)).toBeLessThan(0.01);
  }, 90_000);

  it("replaces an earlier layer instead of stacking, and can remove it", async () => {
    const { engine, docId } = open(scanned());
    const r = await recognise(engine.ocrImage(docId, 0, 200), false);
    engine.addOcrLayers(docId, [{ page: 0, pdf: r.pdf }]);
    engine.addOcrLayers(docId, [{ page: 0, pdf: r.pdf }]);
    const count = (engine.pageText(docId, 0).match(/quick/g) ?? []).length;
    expect(count).toBe(1);
    expect(engine.removeOcrLayers(docId).removed).toBe(1);
    expect(engine.pageText(docId, 0).trim()).toBe("");
    engine.undo(docId);
    expect(engine.pageText(docId, 0)).toMatch(/quick/);
  }, 60_000);
});
