// Generates the PDF test corpus used by unit and end-to-end tests.
// Run: node scripts/make-fixtures.mjs
import * as mupdf from "mupdf";
import forge from "node-forge";
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

// The same 300 pages with nested, collapsed chapters (long part titles), for the bookmarks panel.
{
  const chapters = mupdf.Document.openDocument(many.saveToBuffer("compress"), "application/pdf");
  const it = chapters.outlineIterator();
  for (let part = 0; part < 3; part++) {
    it.insert({ title: `Part ${part + 1}: a fairly long part title that will not fit in a narrow sidebar`, uri: `#page=${part * 100 + 1}`, open: false });
    it.prev();
    it.down();
    for (let ch = 0; ch < 5; ch++) it.insert({ title: `Chapter ${part * 5 + ch + 1}`, uri: `#page=${part * 100 + ch * 20 + 1}`, open: false });
    it.up();
    it.next();
  }
  writeFileSync(new URL("chapters.pdf", out), chapters.asPDF().saveToBuffer("compress").asUint8Array());
}

// Feature-rich document: outline, internal + external links, an attachment, comments, searchable text.
const rich = makeDoc([
  { size: letter, lines: ["Contents", "Go to the chapter on rivers", "Visit example.com", "Search term: aurora appears here."] },
  { size: letter, lines: ["Chapter 1: Mountains", "Mountains are tall. The aurora is visible from the summit.", "Copy this sentence."] },
  { size: letter, lines: ["Chapter 2: Rivers", "Rivers flow downhill. Aurora reflections on the water.", "AURORA in capitals; auroras plural."] },
]);
{
  const p0 = rich.loadPage(0);
  // Line 2 ("Go to the chapter...") sits at baseline y=792-72-40 = 680 in PDF space -> fitz y = 112.
  p0.createLink([72, 98, 260, 116], "#page=3");
  p0.createLink([72, 116, 200, 134], "https://example.com/");
  const it = rich.outlineIterator();
  it.insert({ title: "Contents", uri: "#page=1", open: true });
  it.insert({ title: "Chapter 1: Mountains", uri: "#page=2", open: true });
  it.insert({ title: "Chapter 2: Rivers", uri: "#page=3", open: true });
  const p1 = rich.loadPage(1);
  const note = p1.createAnnotation("Text");
  note.setRect([400, 80, 420, 100]);
  note.setContents("Check the summit height.");
  note.setAuthor("Reviewer");
  note.update();
  const hl = p1.createAnnotation("Highlight");
  hl.setColor([1, 0.85, 0.2]);
  hl.setQuadPoints([[72, 120, 300, 120, 72, 134, 300, 134]]);
  hl.setContents("Important");
  hl.setAuthor("Reviewer");
  hl.update();
  const now = new Date();
  const fs = rich.addEmbeddedFile("notes.txt", "text/plain", new TextEncoder().encode("Attached notes for PDForge tests."), now, now);
  rich.insertEmbeddedFile("notes.txt", fs);
  rich.setMetaData("info:Title", "PDForge Features");
  rich.setMetaData("info:Subject", "Phase 1 test document");
}
writeFileSync(new URL("features.pdf", out), rich.saveToBuffer("compress").asUint8Array());

// Fillable form: text, number with currency total, date, checkbox, radio group, dropdown, list.
{
  const doc = new mupdf.PDFDocument();
  const S = (x) => doc.newString(x);
  const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
  const zadb = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "ZapfDingbats" });
  const labels = ["Name", "Quantity A", "Quantity B", "Total", "Date", "Subscribe", "Size", "Colour", "Delivery", "Notes"];
  let content = "BT /Helv 18 Tf 72 740 Td (Order form) Tj ET\nBT /Helv 11 Tf 72 700 Td ";
  labels.forEach((l, i) => (content += `${i ? "0 -40 Td " : ""}(${l}) Tj `));
  content += "ET";
  const pageObj = doc.addPage([0, 0, 612, 792], 0, doc.addObject({ Font: { Helv: helv } }), content);
  doc.insertPage(0, pageObj);
  const page = doc.findPage(0);
  const fields = doc.newArray();
  const annots = doc.newArray();
  const row = (i, w = 200, h = 20) => [180, 692 - i * 40, 180 + w, 692 - i * 40 + h];
  const DA = S("/Helv 11 Tf 0 g");
  const add = (o) => {
    const ref = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: page, DA, ...o });
    fields.push(ref);
    annots.push(ref);
    return ref;
  };
  const money = { F: { S: "JavaScript", JS: S('AFNumber_Format(2, 0, 0, 0, "$", true);') }, K: { S: "JavaScript", JS: S('AFNumber_Keystroke(2, 0, 0, 0, "$", true);') } };
  add({ FT: "Tx", T: S("name"), TU: S("Full name"), Rect: row(0), Ff: 2 });
  add({ FT: "Tx", T: S("qtyA"), TU: S("Quantity A"), Rect: row(1, 80), V: S("2"), AA: { F: { S: "JavaScript", JS: S('AFNumber_Format(0, 0, 0, 0, "", true);') } } });
  add({ FT: "Tx", T: S("qtyB"), TU: S("Quantity B"), Rect: row(2, 80), V: S("3") });
  const total = add({
    FT: "Tx", T: S("total"), TU: S("Total"), Rect: row(3, 120), Ff: 1,
    AA: { ...money, C: { S: "JavaScript", JS: S('AFSimple_Calculate("SUM", new Array("qtyA", "qtyB"));') } },
  });
  add({ FT: "Tx", T: S("date"), TU: S("Delivery date"), Rect: row(4, 120), AA: { F: { S: "JavaScript", JS: S('AFDate_FormatEx("mm/dd/yyyy");') }, K: { S: "JavaScript", JS: S('AFDate_KeystrokeEx("mm/dd/yyyy");') } } });
  add({ FT: "Btn", T: S("subscribe"), TU: S("Subscribe to updates"), Rect: row(5, 16, 16), DA: S("/ZaDb 0 Tf 0 g"), MK: { CA: S("4") }, V: "Off", AS: "Off" });
  const radio = doc.addObject({ FT: "Btn", T: S("size"), TU: S("Size"), Ff: 49152, V: "Off", Kids: [] });
  fields.push(radio);
  ["S", "L"].forEach((state, i) => {
    const kid = doc.addObject({
      Type: "Annot", Subtype: "Widget", Parent: radio, F: 4, P: page, DA: S("/ZaDb 0 Tf 0 g"), MK: { CA: S("l") }, AS: "Off",
      Rect: [180 + i * 60, 692 - 6 * 40, 196 + i * 60, 708 - 6 * 40],
      AP: { N: { [state]: doc.addStream("", {}), Off: doc.addStream("", {}) } },
    });
    radio.get("Kids").push(kid);
    annots.push(kid);
  });
  add({ FT: "Ch", T: S("colour"), TU: S("Colour"), Ff: 131072, Opt: [S("Red"), S("Green"), S("Blue")], V: S("Green"), Rect: row(7, 120) });
  add({ FT: "Ch", T: S("delivery"), TU: S("Delivery"), Opt: [S("Standard"), S("Express"), S("Pickup")], Rect: [180, 692 - 8 * 40 - 20, 300, 712 - 8 * 40] });
  add({ FT: "Tx", T: S("notes"), TU: S("Notes"), Ff: 4096, Rect: [180, 692 - 9 * 40 - 40, 500, 712 - 9 * 40] });
  page.put("Annots", annots);
  doc.getTrailer().get("Root").put("AcroForm", { Fields: fields, DA: S("/Helv 0 Tf 0 g"), DR: { Font: { Helv: helv, ZaDb: zadb } }, NeedAppearances: true, CO: [total] });
  writeFileSync(new URL("form.pdf", out), doc.saveToBuffer("").asUint8Array());
}

// Document with personal data for redaction, plus hidden data for sanitising.
{
  const doc = makeDoc([
    {
      size: letter,
      lines: [
        "Customer record",
        "Contact: jane.doe@example.com, phone +1 (555) 123-4567",
        "SSN 123-45-6789",
        "Card 4111 1111 1111 1111 and fake 4111 1111 1111 1112",
        "Secret project codename BLUEBIRD.",
      ],
    },
    { size: letter, lines: ["Page two", "BLUEBIRD appears again here."] },
  ]);
  // A grey image block to redact pixels from.
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 100, 100], false);
  pix.clear(128);
  const page = doc.findPage(0);
  page.get("Resources").put("XObject", { Im1: doc.addImage(new mupdf.Image(pix)) });
  const extra = doc.addStream("q 200 0 0 200 72 300 cm /Im1 Do Q", {});
  page.put("Contents", [page.get("Contents"), extra]);
  const S = (x) => doc.newString(x);
  doc.getTrailer().get("Root").put("OpenAction", { S: "JavaScript", JS: S("app.alert('hello');") });
  doc.getTrailer().get("Root").put("PieceInfo", { App: { Private: S("secret app data") } });
  const now = new Date();
  doc.insertEmbeddedFile("hidden.txt", doc.addEmbeddedFile("hidden.txt", "text/plain", new TextEncoder().encode("hidden attachment"), now, now));
  doc.setMetaData("info:Author", "Jane Doe");
  doc.setMetaData("info:Title", "Customer record");
  writeFileSync(new URL("redact.pdf", out), doc.saveToBuffer("").asUint8Array());
}

// Self-signed test identity for signature tests (password "test"), using 3DES like older Windows exports.
{
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2024-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2036-01-01T00:00:00Z");
  const attrs = [
    { name: "commonName", value: "Test Signer" },
    { name: "organizationName", value: "PDForge Tests" },
    { name: "emailAddress", value: "signer@example.com" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "keyUsage", digitalSignature: true, nonRepudiation: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "test", { algorithm: "3des", friendlyName: "Test Signer" });
  writeFileSync(new URL("test-signer.p12", out), Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"));
}

// Phase 4: a scan (image-only page) for OCR, a photo-heavy file for compression, and a damaged file.
{
  const src = mupdf.Document.openDocument(new URL("sample.pdf", out).pathname, "application/pdf");
  const page = src.loadPage(0);
  const s = 200 / 72;
  const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, false);
  const doc = new mupdf.PDFDocument();
  const res = doc.addObject({ XObject: { Scan: doc.addImage(new mupdf.Image(pix)) } });
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, "q 612 0 0 792 0 0 cm /Scan Do Q"));
  writeFileSync(new URL("scanned.pdf", out), doc.saveToBuffer("compress").asUint8Array());
}
{
  const w = 1000;
  const h = 750;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  const stride = pix.getStride();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * 3;
      px[i] = (x * 255) / w;
      px[i + 1] = (y * 255) / h;
      px[i + 2] = 128 + 100 * Math.sin(x / 40) * Math.cos(y / 30);
    }
  }
  const doc = makeDoc([{ size: letter, lines: ["Photo report", "A large photo drawn small."] }]);
  const page = doc.findPage(0);
  page.get("Resources").put("XObject", { Photo: doc.addImage(new mupdf.Image(pix)) });
  const extra = doc.addStream("q 288 0 0 216 72 420 cm /Photo Do Q", {});
  const contents = doc.newArray();
  contents.push(page.get("Contents"));
  contents.push(extra);
  page.put("Contents", contents);
  writeFileSync(new URL("photo.pdf", out), doc.saveToBuffer("compress").asUint8Array());
}
{
  const good = Buffer.from(sample.saveToBuffer("compress").asUint8Array()).toString("latin1");
  writeFileSync(new URL("damaged.pdf", out), Buffer.from(good.replace(/startxref\s+\d+/, "startxref\n12345"), "latin1"));
}

// Phase 5: a revised copy of the sample (for Compare) and a page with a table.
{
  const v2 = makeDoc([
    { size: letter, lines: ["PDForge sample document", "Page one of five.", "The quick red fox jumps over the sleepy dog."] },
    { size: letter, lines: ["Second page", "Searchable text: invoice number 4822."] },
    { size: [792, 612], lines: ["Landscape page", "This page is wider than it is tall."] },
    { size: [420, 595], lines: ["A5 page", "Smaller paper size."] },
    { size: letter, lines: ["Last page", "End of the sample document."] },
  ]);
  writeFileSync(new URL("sample-v2.pdf", out), v2.saveToBuffer("compress").asUint8Array());
}
{
  const pdf = new mupdf.PDFDocument();
  const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
  const rows = [["Region", "Q1", "Q2", "Total"], ["North", "1,200", "1,350", "2,550"], ["South", "980", "1,010", "1,990"], ["West coast", "2,100", "2,240", "4,340"]];
  const xs = [72, 200, 270, 340];
  let content = "BT /F1 18 Tf 72 720 Td (Quarterly sales) Tj ET\n";
  rows.forEach((r, i) => r.forEach((cell, j) => (content += `BT /F1 11 Tf ${xs[j]} ${670 - i * 18} Td (${cell}) Tj ET\n`)));
  content += "BT /F1 11 Tf 72 570 Td (Figures in thousands.) Tj ET\n";
  pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, pdf.addObject({ Font: { F1: font } }), content));
  writeFileSync(new URL("table.pdf", out), pdf.saveToBuffer("compress").asUint8Array());
}

console.log("fixtures written");
