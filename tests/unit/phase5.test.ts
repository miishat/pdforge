import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";
import { compareWords, diffTokens, type Word } from "../../src/core/compare";
import { toCsv, uniqueSheetNames } from "../../src/core/tables";
import { humanize } from "../../src/core/a11y";
import { unzip } from "../../src/core/zip";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const enc = new TextEncoder();
function openBytes(engine: PdfEngine, bytes: Uint8Array) {
  const r = engine.open(bytes);
  if (r.status !== "ok") throw new Error("expected ok");
  return r.info.docId;
}
const html = (engine: PdfEngine, body: string) => engine.convertToPdf([{ name: "x.html", bytes: enc.encode(`<html><body>${body}</body></html>`) }], { pageSize: [612, 792] });

describe("diff", () => {
  it("finds the minimal edits", () => {
    const m = diffTokens([1, 2, 3, 4, 5], [1, 3, 4, 9, 5]);
    expect(m).toEqual([[0, 0], [2, 1], [3, 2], [4, 4]]);
    expect(diffTokens([], [1])).toEqual([]);
    expect(diffTokens([1, 2], [1, 2])).toEqual([[0, 0], [1, 1]]);
  });

  it("groups word changes and ignores typographic quote differences", () => {
    const w = (t: string, i: number, page = 0): Word => ({ text: t, page, rect: [i * 10, 0, i * 10 + 8, 10] });
    const a = "the quick brown fox jumps".split(" ").map((t, i) => w(t, i));
    const b = "the slow brown dog fox leaps".split(" ").map((t, i) => w(t, i));
    const r = compareWords(a, b);
    expect(r.changes.map((c) => [c.kind, c.before, c.after])).toEqual([
      ["replace", "quick", "slow"],
      ["insert", "", "dog"],
      ["replace", "jumps", "leaps"],
    ]);
    expect(compareWords([w("it’s", 0)], [w("it's", 0)]).changes).toEqual([]);
  });

  it("compares two documents' text with page locations", () => {
    const engine = new PdfEngine();
    const a = openBytes(engine, html(engine, "<p>The contract starts on 1 March and runs for twelve months.</p><p>Payment is due monthly.</p>"));
    const b = openBytes(engine, html(engine, "<p>The contract starts on 1 April and runs for twelve months.</p><p>Payment is due quarterly in advance.</p>"));
    const r = engine.compareText(a, b);
    expect(r.coarse).toBe(false);
    expect(r.changes.map((c) => [c.kind, c.before, c.after])).toEqual([
      ["replace", "March", "April"],
      ["replace", "monthly.", "quarterly in advance."],
    ]);
    expect(r.changes[0].aRects[0].page).toBe(0);
    expect(r.changes[0].bRects).toHaveLength(1);
  });

  it("finds visual differences that aren't text", () => {
    const engine = new PdfEngine();
    const a = openBytes(engine, fixture("sample.pdf"));
    const b = openBytes(engine, fixture("sample.pdf"));
    // Identical pages, including ones whose size doesn't divide evenly into pixels (the A5 page).
    for (let p = 0; p < 5; p++) expect(engine.compareVisual(a, p, b, p)).toEqual([]);
    // Draw a box on page 1 of the second copy.
    engine.addBackground(b, { color: [1, 1, 1], pages: [0] } as never);
    const c = openBytes(engine, (() => {
      const pdf = mupdf.Document.openDocument(fixture("sample.pdf"), "application/pdf").asPDF()!;
      const page = pdf.loadPage(0) as mupdf.PDFPage;
      const extra = pdf.addStream("0 0 1 rg 400 600 80 80 re f", {});
      const arr = pdf.newArray();
      arr.push(page.getObject().get("Contents"));
      arr.push(extra);
      page.getObject().put("Contents", arr);
      return pdf.saveToBuffer("").asUint8Array().slice();
    })());
    const regions = engine.compareVisual(a, 0, c, 0);
    expect(regions).toHaveLength(1);
    // The square is at x 400–480, y (from the top) 792-680 = 112 to 192.
    const [x0, y0, x1, y1] = regions[0];
    expect(x0).toBeLessThanOrEqual(401);
    expect(x1).toBeGreaterThanOrEqual(479);
    expect(y0).toBeLessThanOrEqual(113);
    expect(y1).toBeGreaterThanOrEqual(191);
  });
});

describe("tables", () => {
  const TABLE = `<h2>Quarterly sales</h2><p>Figures in thousands.</p>
<table><tr><th>Region</th><th>Q1</th><th>Q2</th><th>Total</th></tr>
<tr><td>North</td><td>1,200</td><td>1,350</td><td>2,550</td></tr>
<tr><td>South</td><td>980</td><td>1,010</td><td>1,990</td></tr>
<tr><td>West coast</td><td>2,100</td><td>2,240</td><td>4,340</td></tr></table>
<p>Prepared by the finance team for the board meeting in the spring.</p>`;

  /** A table as word processors write one: each cell's text placed at its column's position. */
  function tablePdf(): Uint8Array {
    const pdf = new mupdf.PDFDocument();
    const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
    const rows = [["Region", "Q1", "Q2", "Total"], ["North", "1,200", "1,350", "2,550"], ["South", "980", "1,010", "1,990"], ["West coast", "2,100", "2,240", "4,340"]];
    const xs = [72, 200, 270, 340];
    let content = "BT /F1 16 Tf 72 720 Td (Quarterly sales) Tj ET\nBT /F1 11 Tf 72 696 Td (Figures in thousands, as reported by each regional office.) Tj ET\n";
    rows.forEach((r, i) => r.forEach((cell, j) => (content += `BT /F1 11 Tf ${xs[j]} ${660 - i * 18} Td (${cell}) Tj ET\n`)));
    content += "BT /F1 11 Tf 72 560 Td (Prepared by the finance team for the board meeting in the spring.) Tj ET\n";
    pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, pdf.addObject({ Font: { F1: font } }), content));
    return pdf.saveToBuffer("").asUint8Array().slice();
  }

  it("finds a table and its cells", () => {
    const engine = new PdfEngine();
    const doc = openBytes(engine, tablePdf());
    const tables = engine.findTables(doc);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([
      ["Region", "Q1", "Q2", "Total"],
      ["North", "1,200", "1,350", "2,550"],
      ["South", "980", "1,010", "1,990"],
      ["West coast", "2,100", "2,240", "4,340"],
    ]);
  });

  it("reads tables with cells only a space apart (as MuPDF lays out HTML)", () => {
    const engine = new PdfEngine();
    const tables = engine.findTables(openBytes(engine, html(engine, TABLE.replace("West coast", "West"))));
    expect(tables).toHaveLength(1);
    expect(tables[0].rows[0]).toEqual(["Region", "Q1", "Q2", "Total"]);
    expect(tables[0].rows).toHaveLength(4);
  });

  it("finds no tables in ordinary text", () => {
    const engine = new PdfEngine();
    expect(engine.findTables(openBytes(engine, fixture("sample.pdf")))).toEqual([]);
  });

  it("writes CSV and an Excel workbook with numbers as numbers", async () => {
    expect(toCsv([["a", "b,c"], ['say "hi"', "x\ny"]])).toBe('﻿a,"b,c"\r\n"say ""hi""","x\ny"\r\n');
    const engine = new PdfEngine();
    const xlsx = await engine.tablesToXlsx([{ name: "Page 1: table 1", rows: [["Region", "Q1"], ["North", "1,200"]] }]);
    const files = await unzip(xlsx);
    const sheet = new TextDecoder().decode(files.get("xl/worksheets/sheet1.xml"));
    expect(sheet).toContain('<c r="B2"><v>1200</v></c>');
    expect(sheet).toContain("<t xml:space=\"preserve\">Region</t>");
    expect(new TextDecoder().decode(files.get("xl/workbook.xml"))).toContain('name="Page 1  table 1"');
    expect(uniqueSheetNames(["A", "a", "x".repeat(40)])).toEqual(["A", "a 2", "x".repeat(31)]);
  });
});

describe("accessibility", () => {
  it("reports problems and fixes the simple ones", () => {
    const engine = new PdfEngine();
    const doc = openBytes(engine, fixture("features.pdf"));
    const r = engine.checkAccessibility(doc, { fileName: "features.pdf", lang: "en-GB" });
    const status = (id: string) => r.checks.find((c) => c.id === id)?.status;
    expect(status("tagged")).toBe("fail");
    expect(status("language")).toBe("fail");
    expect(status("title")).toBe("fail");
    expect(status("tabs")).toBe("fail");
    expect(r.suggested.language).toBe("en-GB");
    expect(r.suggested.title).toBe("PDForge Features");

    const fixed = engine.fixAccessibility(doc, { language: "en-GB", title: "Feature tour", tabOrder: true, linkText: true });
    expect(fixed.done).toEqual(["language", "title", "tab order", "link descriptions"]);
    const again = engine.checkAccessibility(doc, { fileName: "features.pdf", lang: "en-GB" });
    for (const id of ["language", "title", "tabs", "links"]) expect(again.checks.find((c) => c.id === id)?.status).toBe("pass");
    // Undo restores the original.
    engine.undo(doc);
    expect(engine.checkAccessibility(doc, { fileName: "features.pdf", lang: "en" }).checks.find((c) => c.id === "language")?.status).toBe("fail");
  });

  it("gives form fields descriptions from their names", () => {
    expect(humanize("txtFirstName")).toBe("First name");
    expect(humanize("form.date_of_birth")).toBe("Date of birth");
    const engine = new PdfEngine();
    // The form fixture has tooltips; remove one to test the fix.
    const pdf = mupdf.Document.openDocument(fixture("form.pdf"), "application/pdf").asPDF()!;
    pdf.getTrailer().get("Root").get("AcroForm").get("Fields").get(0).delete("TU");
    const doc = openBytes(engine, pdf.saveToBuffer("").asUint8Array().slice());
    expect(engine.checkAccessibility(doc, { fileName: "f", lang: "en" }).checks.find((c) => c.id === "fields")?.status).toBe("fail");
    engine.fixAccessibility(doc, { tooltips: true });
    expect(engine.checkAccessibility(doc, { fileName: "f", lang: "en" }).checks.find((c) => c.id === "fields")?.status).toBe("pass");
  });

  it("flags scans and builds bookmarks from headings", () => {
    const engine = new PdfEngine();
    const scan = openBytes(engine, fixture("scanned.pdf"));
    expect(engine.checkAccessibility(scan, { fileName: "s", lang: "en" }).checks.find((c) => c.id === "text")?.status).toBe("fail");
    const doc = openBytes(engine, html(engine, "<h1>Intro</h1><p>Text.</p><h2>Details</h2><p>More text here.</p><h1>Summary</h1><p>End.</p>"));
    engine.fixAccessibility(doc, { bookmarks: true });
    const outline = engine.outline(doc);
    expect(outline.map((n) => n.title)).toEqual(["Intro", "Summary"]);
    expect(outline[0].children.map((n) => n.title)).toEqual(["Details"]);
  });
});
