import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";
import { unzip, zip } from "../../src/core/zip";
import { srgbProfile } from "../../src/core/icc";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const enc = new TextEncoder();
const dec = new TextDecoder();

const HTML = `<html><body>
<h1>Annual River Report</h1>
<p>The <b>quick</b> brown fox swims across the <i>wide</i> river every morning before the sun is up.</p>
<h2>Findings</h2>
<ul><li>Water levels rose</li><li>Fish counts doubled</li></ul>
<p>Use <code>flow_rate</code> for details.</p>
</body></html>`;

function openBytes(bytes: Uint8Array) {
  const engine = new PdfEngine();
  const r = engine.open(bytes);
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}

describe("zip", () => {
  it("round-trips stored and deflated entries", async () => {
    const big = enc.encode("hello ".repeat(500));
    const z = await zip([{ name: "a.txt", data: big }, { name: "dir/b.bin", data: new Uint8Array([1, 2, 3]) }]);
    const files = await unzip(z);
    expect(dec.decode(files.get("a.txt"))).toBe("hello ".repeat(500));
    expect([...files.get("dir/b.bin")!]).toEqual([1, 2, 3]);
    expect(z.length).toBeLessThan(big.length);
  });
});

describe("to PDF", () => {
  it("lays out HTML as real text", () => {
    const engine = new PdfEngine();
    const pdf = engine.convertToPdf([{ name: "report.html", bytes: enc.encode(HTML) }], { pageSize: [612, 792] });
    const { engine: e2, docId } = openBytes(pdf);
    expect(e2.pageText(docId, 0)).toContain("Annual River Report");
    expect(e2.info(docId).pages[0]).toEqual({ width: 612, height: 792 });
  });

  it("converts Word documents", async () => {
    const docx = await zip([
      { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
      { name: "_rels/.rels", data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
      { name: "word/_rels/document.xml.rels", data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>') },
      { name: "word/document.xml", data: enc.encode('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p></w:body></w:document>') },
    ]);
    const pdf = new PdfEngine().convertToPdf([{ name: "letter.docx", bytes: docx }]);
    const { engine, docId } = openBytes(pdf);
    expect(engine.pageText(docId, 0)).toContain("Hello from Word");
  });

  it("fits images on paper and combines several files", () => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 400, 300], false);
    pix.clear(90);
    const png = pix.asPNG().slice();
    const pdf = new PdfEngine().convertToPdf(
      [{ name: "a.png", bytes: png }, { name: "b.txt", bytes: enc.encode("Plain words") }],
      { pageSize: [595, 842] },
    );
    const { engine, docId } = openBytes(pdf);
    const info = engine.info(docId);
    expect(info.pageCount).toBe(2);
    // A landscape image goes on landscape paper.
    expect(info.pages[0]).toEqual({ width: 842, height: 595 });
    expect(engine.pageText(docId, 1)).toContain("Plain words");
  });

  it("explains unsupported files", () => {
    expect(() => new PdfEngine().convertToPdf([{ name: "x.psd", bytes: new Uint8Array(4) }])).toThrow(/can't convert \.psd/);
  });
});

describe("from PDF", () => {
  const source = () => openBytes(new PdfEngine().convertToPdf([{ name: "r.html", bytes: enc.encode(HTML) }], { pageSize: [612, 792] }));

  it("exports Markdown with headings, emphasis, lists and code", () => {
    const { engine, docId } = source();
    const md = engine.exportMarkdown(docId, { images: false });
    expect(md).toMatch(/^# Annual River Report$/m);
    expect(md).toMatch(/^## Findings$/m);
    expect(md).toContain("**quick**");
    expect(md).toContain("*wide*");
    expect(md).toMatch(/^- Water levels rose$/m);
    expect(md).toMatch(/^- Fish counts doubled$/m);
    expect(md).toContain("`flow_rate`");
  });

  it("exports HTML", () => {
    const { engine, docId } = source();
    const html = engine.exportHtml(docId, { images: false, title: "River <report>" });
    expect(html).toContain("<title>River &lt;report&gt;</title>");
    expect(html).toContain("<h1>Annual River Report</h1>");
    expect(html).toMatch(/<ul>\s*<li>Water levels rose<\/li>/);
    expect(html).toContain("<strong>quick</strong>");
  });

  it("exports a Word document MuPDF can read back", async () => {
    const { engine, docId } = source();
    const docx = await engine.exportDocx(docId, { images: true, title: "River" });
    const files = await unzip(docx);
    const xml = dec.decode(files.get("word/document.xml"));
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain('<w:numId w:val="1"/>');
    const back = mupdf.Document.openDocument(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(back.loadPage(0).toStructuredText("").asText()).toContain("Annual River Report");
  });

  it("exports plain text with page breaks", () => {
    const { engine, docId } = openBytes(fixture("sample.pdf"));
    const text = engine.exportText(docId);
    expect(text.split("\f")).toHaveLength(5);
    expect(text).toContain("quick brown fox");
  });

  it("exports pages as PNG, JPEG and multi-page TIFF", async () => {
    const { engine, docId } = openBytes(fixture("sample.pdf"));
    const png = await engine.exportImages(docId, { format: "png", dpi: 72, pages: [0, 1] });
    expect(png).toHaveLength(2);
    expect([...png[0].bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    const jpg = await engine.exportImages(docId, { format: "jpeg", dpi: 100, pages: [0], quality: 80 });
    expect([...jpg[0].bytes.slice(0, 2)]).toEqual([0xff, 0xd8]);
    const tiff = await engine.exportImages(docId, { format: "tiff", dpi: 50, pages: [0, 1, 2], singleTiff: true });
    expect(tiff).toHaveLength(1);
    // MuPDF reads it back as three pages of the right size.
    const t = mupdf.Document.openDocument(tiff[0].bytes, "image/tiff");
    expect(t.countPages()).toBe(3);
    const pix = t.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    expect(pix.getWidth()).toBe(Math.round((612 * 50) / 72));
  });
});

describe("sRGB profile", () => {
  it("is a valid ICC profile MuPDF accepts", () => {
    const icc = srgbProfile();
    expect(new DataView(icc.buffer).getUint32(0)).toBe(icc.length);
    const cs = new mupdf.ColorSpace(icc, "sRGB");
    expect(cs.isRGB()).toBe(true);
  });
});
