import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";
import { pdfDate } from "../../src/core/signing";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

function open(bytes: Uint8Array) {
  const engine = new PdfEngine();
  const r = engine.open(bytes);
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}

describe("certificate signatures", () => {
  it("opens a PKCS#12 identity and rejects a wrong password", () => {
    const { engine } = open(fixture("sample.pdf"));
    expect(() => engine.openIdentity(fixture("test-signer.p12"), "nope")).toThrow(/password/);
    const id = engine.openIdentity(fixture("test-signer.p12"), "test");
    expect(id).toMatchObject({ name: "Test Signer", email: "signer@example.com", organization: "PDForge Tests", keyType: "RSA" });
  });

  it("signs a document and verifies the signature as valid", async () => {
    const { engine, docId } = open(fixture("sample.pdf"));
    const { token } = engine.openIdentity(fixture("test-signer.p12"), "test");
    const original = fixture("sample.pdf");
    const signed = await engine.sign(docId, token, { pageIndex: 0, rect: [72, 600, 300, 660], reason: "Approval", location: "Lisbon" });
    // Incremental: the original file is untouched at the start.
    expect(Buffer.from(signed.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);

    const sigs = await engine.signatures(docId);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ status: "valid", signer: "Test Signer", reason: "Approval", location: "Lisbon", selfSigned: true, laterChanges: false, page: 0 });
    expect(sigs[0].fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    // Reopening the signed bytes elsewhere gives the same verdict.
    const again = open(signed);
    expect((await again.engine.signatures(again.docId))[0].status).toBe("valid");
    // The signature box has a visible appearance (dark text pixels inside its rectangle).
    const box = again.engine.render({ docId: again.docId, pageIndex: 0, scale: 1, rotation: 0, region: [72, 600, 300, 660] });
    let dark = 0;
    for (let k = 0; k < box.pixels.length; k += 4) if (box.pixels[k] < 120) dark++;
    expect(dark).toBeGreaterThan(100);
  });

  it("detects tampering with signed bytes", async () => {
    const { engine, docId } = open(fixture("sample.pdf"));
    const { token } = engine.openIdentity(fixture("test-signer.p12"), "test");
    const signed = await engine.sign(docId, token, { pageIndex: 0 });
    const tampered = signed.slice();
    // Change the PDF version digit in the header: still a readable PDF, but no longer what was signed.
    expect(String.fromCharCode(...tampered.subarray(0, 8))).toBe("%PDF-1.7");
    tampered[7] = "6".charCodeAt(0);
    const t = open(tampered);
    expect((await t.engine.signatures(t.docId))[0].status).toBe("invalid");
  });

  it("reports changes made after signing", async () => {
    const { engine, docId } = open(fixture("sample.pdf"));
    const { token } = engine.openIdentity(fixture("test-signer.p12"), "test");
    await engine.sign(docId, token, { pageIndex: 0, rect: [72, 600, 300, 660] });
    engine.createAnnotation(docId, 1, { author: "x", type: "Text", point: [10, 10] });
    const later = engine.save(docId);
    engine.setFileBytes(docId, later);
    const sigs = await engine.signatures(docId);
    expect(sigs[0].status).toBe("modified");
    expect(sigs[0].laterChanges).toBe(true);
  });

  it("supports two signatures on one document", async () => {
    const { engine, docId } = open(fixture("form.pdf"));
    const { token } = engine.openIdentity(fixture("test-signer.p12"), "test");
    await engine.sign(docId, token, { pageIndex: 0, rect: [350, 80, 550, 130] });
    await engine.sign(docId, token, { pageIndex: 0, rect: [350, 140, 550, 190] });
    const sigs = await engine.signatures(docId);
    expect(sigs.map((s) => s.status).sort()).toEqual(["modified", "valid"]);
    expect(new Set(sigs.map((s) => s.field)).size).toBe(2);
  });

  it("signs into an existing empty signature field", async () => {
    // Add an empty signature field by signing nothing: create the widget through a first signature, then a blank one.
    const { engine, docId } = open(fixture("sample.pdf"));
    const pdf = (engine as unknown as { docs: Map<number, { doc: mupdf.Document }> }).docs.get(docId)!.doc.asPDF()!;
    pdf.beginOperation("add field");
    const page = pdf.findPage(0);
    const field = pdf.addObject({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: pdf.newString("Approver"), Rect: [72, 72, 272, 132], F: 4, P: page });
    page.put("Annots", [field]);
    pdf.getTrailer().get("Root").put("AcroForm", { Fields: [field] });
    pdf.endOperation();
    const ws = engine.widgets(docId, 0);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ type: "signature", signed: false });
    const { token } = engine.openIdentity(fixture("test-signer.p12"), "test");
    await engine.sign(docId, token, { pageIndex: 0, fieldId: ws[0].id });
    const after = engine.widgets(docId, 0);
    expect(after).toHaveLength(1);
    expect(after[0].signed).toBe(true);
    expect((await engine.signatures(docId))[0]).toMatchObject({ status: "valid", field: "Approver" });
  });

  it("writes PDF dates with a time zone", () => {
    expect(pdfDate(new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^D:20260102030405[+-]\d{2}'\d{2}'$/);
  });

  it("produces a file other PDF tools can open", async () => {
    const { engine, docId } = open(fixture("sample.pdf"));
    const { token } = engine.openIdentity(fixture("test-signer.p12"), "test");
    const signed = await engine.sign(docId, token, { pageIndex: 0, rect: [72, 600, 300, 660] });
    const d = mupdf.Document.openDocument(signed, "application/pdf").asPDF()!;
    expect(d.wasRepaired()).toBe(false);
    expect(d.countPages()).toBe(5);
  });
});
