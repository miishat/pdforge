// Generates the PDF test corpus used by unit and end-to-end tests.
// Run: node scripts/make-fixtures.mjs
import * as mupdf from "mupdf";
import { writeFileSync, mkdirSync } from "node:fs";

const out = new URL("../tests/fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });

function makeDoc(pages) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  pages.forEach(({ size, lines }, i) => {
    const [w, h] = size;
    const resources = doc.addObject({ Font: { F1: font } });
    let y = h - 72;
    let content = "";
    for (const line of lines) {
      const safe = line.replace(/[()\\]/g, (c) => "\\" + c);
      content += `BT /F1 ${line === lines[0] ? 24 : 12} Tf 72 ${y} Td (${safe}) Tj ET\n`;
      y -= line === lines[0] ? 40 : 18;
    }
    content += `0.85 0.35 0.15 RG 2 w 72 72 m ${w - 72} 72 l S\n`;
    const page = doc.addPage([0, 0, w, h], 0, resources, content);
    doc.insertPage(i, page);
  });
  return doc;
}

const letter = [612, 792];
const sample = makeDoc([
  { size: letter, lines: ["PDForge sample document", "Page one of five.", "The quick brown fox jumps over the lazy dog."] },
  { size: letter, lines: ["Second page", "Searchable text: invoice number 4821."] },
  { size: [792, 612], lines: ["Landscape page", "This page is wider than it is tall."] },
  { size: [420, 595], lines: ["A5 page", "Smaller paper size."] },
  { size: letter, lines: ["Last page", "End of the sample document."] },
]);
sample.setMetaData("info:Title", "PDForge Sample");
sample.setMetaData("info:Author", "PDForge tests");
writeFileSync(new URL("sample.pdf", out), sample.saveToBuffer("compress").asUint8Array());

const secret = makeDoc([{ size: letter, lines: ["Encrypted document", "Password is: secret"] }]);
writeFileSync(
  new URL("encrypted.pdf", out),
  secret.saveToBuffer("encrypt=aes-256,user-password=secret,owner-password=owner").asUint8Array(),
);

const many = makeDoc(Array.from({ length: 300 }, (_, i) => ({ size: letter, lines: [`Page ${i + 1}`, "Long document for performance tests."] })));
writeFileSync(new URL("long-300.pdf", out), many.saveToBuffer("compress").asUint8Array());

console.log("fixtures written");
