import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";
import { ALL_PERMISSIONS, describeEncryption, fromPermissionBits, permissionBits, validateSecurity } from "../../src/core/protect";
import { PRESETS } from "../../src/core/optimize";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
function open(bytes: Uint8Array = fixture("sample.pdf")) {
  const engine = new PdfEngine();
  const r = engine.open(bytes);
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}
const reopen = (bytes: Uint8Array) => mupdf.Document.openDocument(bytes, "application/pdf");

/** A page with a smooth photo-like gradient image drawn at about 600 dpi. */
function photoPdf(): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  const w = 2000;
  const h = 1500;
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
  const ref = pdf.addImage(new mupdf.Image(pix));
  const res = pdf.addObject({ XObject: { Im0: ref } });
  pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, res, "q 240 0 0 180 72 500 cm /Im0 Do Q BT /F1 12 Tf 72 400 Td ET"));
  return pdf.saveToBuffer("compress").asUint8Array().slice();
}

describe("permissions", () => {
  it("encodes the PDF permission bits, with reserved bits set", () => {
    expect(permissionBits(ALL_PERMISSIONS)).toBe(-4);
    const none = permissionBits({ ...ALL_PERMISSIONS, print: false, printHigh: false, copy: false, edit: false, annotate: false, fillForms: false, assemble: false, accessibility: false });
    expect(none).toBe(-3904);
    const printOnly = { ...fromPermissionBits(none), print: true };
    expect(fromPermissionBits(permissionBits(printOnly))).toEqual(printOnly);
    // No high-quality printing without printing.
    expect(fromPermissionBits(permissionBits({ ...ALL_PERMISSIONS, print: false })).printHigh).toBe(false);
  });

  it("rejects unsafe password choices", () => {
    expect(validateSecurity({ userPassword: "", ownerPassword: "", permissions: ALL_PERMISSIONS })).toMatch(/permissions password/);
    expect(validateSecurity({ userPassword: "same", ownerPassword: "same", permissions: ALL_PERMISSIONS })).toMatch(/different/);
    expect(validateSecurity({ userPassword: "a,b", ownerPassword: "x", permissions: ALL_PERMISSIONS })).toMatch(/commas/);
    expect(validateSecurity({ userPassword: "open", ownerPassword: "owner", permissions: ALL_PERMISSIONS })).toBeNull();
  });

  it("describes encryption strength", () => {
    expect(describeEncryption("Standard V5 R6 256-bit AES")).toEqual({ encrypted: true, label: "AES 256-bit", weak: false });
    expect(describeEncryption("Standard V1 R2 40-bit RC4").weak).toBe(true);
    expect(describeEncryption("None").encrypted).toBe(false);
  });
});

describe("security", () => {
  it("adds an AES-256 open password and restrictions on save", () => {
    const { engine, docId } = open();
    const state = engine.setSecurity(docId, {
      userPassword: "open sesame",
      ownerPassword: "owner",
      permissions: { ...ALL_PERMISSIONS, copy: false, edit: false },
    });
    expect(state.pending).toBe("encrypt");
    expect(engine.editState(docId).dirty).toBe(true);
    const bytes = engine.save(docId);
    const d = reopen(bytes);
    expect(d.needsPassword()).toBe(true);
    expect(d.getMetaData("encryption")).toMatch(/256-bit AES/);
    expect(d.authenticatePassword("wrong")).toBe(0);
    expect(d.authenticatePassword("open sesame")).toBeGreaterThan(0);
    expect(d.hasPermission("copy")).toBe(false);
    expect(d.hasPermission("print")).toBe(true);
    // The open tab continues from the protected file, with full rights.
    const after = engine.security(docId);
    expect(after).toMatchObject({ encrypted: true, method: "AES 256-bit", pending: null, canChange: true });
    expect(engine.editState(docId).dirty).toBe(false);
    expect(engine.pageText(docId, 0)).toContain("PDForge sample document");
  });

  it("needs the permissions password before changing a restricted file, then removes security", () => {
    const protectedBytes = (() => {
      const { engine, docId } = open();
      engine.setSecurity(docId, { userPassword: "", ownerPassword: "boss", permissions: { ...ALL_PERMISSIONS, print: false } });
      return engine.save(docId);
    })();
    const { engine, docId } = open(protectedBytes);
    const state = engine.security(docId);
    expect(state).toMatchObject({ encrypted: true, hasOpenPassword: false, canChange: false });
    expect(state.permissions.print).toBe(false);
    expect(() => engine.removeSecurity(docId)).toThrow(/permissions password/);
    expect(() => engine.unlockOwner(docId, "nope")).toThrow();
    engine.unlockOwner(docId, "boss");
    expect(engine.removeSecurity(docId).pending).toBe("decrypt");
    const plain = engine.save(docId);
    expect(reopen(plain).getMetaData("encryption")).toBe("None");
    expect(engine.security(docId).encrypted).toBe(false);
  });

  it("opens with the user password but can't change security without the owner password", () => {
    const { engine: e1, docId: d1 } = open();
    e1.setSecurity(d1, { userPassword: "u", ownerPassword: "o", permissions: ALL_PERMISSIONS });
    const bytes = e1.save(d1);
    const engine = new PdfEngine();
    const r = engine.open(bytes);
    expect(r.status).toBe("needs-password");
    if (r.status !== "needs-password") return;
    engine.unlock(r.docId, "u");
    expect(engine.security(r.docId).canChange).toBe(false);
    engine.unlockOwner(r.docId, "o");
    expect(engine.security(r.docId).canChange).toBe(true);
  });

  it("can cancel a security change before saving", () => {
    const { engine, docId } = open();
    engine.setSecurity(docId, { userPassword: "x", ownerPassword: "y", permissions: ALL_PERMISSIONS });
    engine.cancelSecurityChange(docId);
    expect(reopen(engine.save(docId)).needsPassword()).toBe(false);
  });
});

describe("compress", () => {
  it("downsamples oversized images and reports the size before and after", () => {
    const { engine, docId } = open(photoPdf());
    const r = engine.compress(docId, PRESETS.ebook);
    expect(r.report.imagesResampled).toBe(1);
    expect(r.after).toBeLessThan(r.before * 0.5);
    const saved = engine.save(docId);
    expect(saved.length).toBe(r.after);
    // The image is now about 150 dpi: 240pt wide = 3.33in → ~500px.
    const d = reopen(saved).asPDF()!;
    const xo = (d.loadPage(0) as mupdf.PDFPage).getObject().get("Resources").get("XObject").get("Im0");
    expect(xo.get("Width").asNumber()).toBeGreaterThan(480);
    expect(xo.get("Width").asNumber()).toBeLessThan(520);
    expect(xo.get("Filter").asName()).toBe("DCTDecode");
    // It still renders.
    const pix = d.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    expect(pix.getWidth()).toBe(612);
  });

  it("is one undoable step", () => {
    const { engine, docId } = open(photoPdf());
    const before = engine.fileSize(docId);
    engine.compress(docId, PRESETS.screen);
    expect(engine.editState(docId).undoLabel).toBe("Compress");
    engine.undo(docId);
    // Undone: the image is back at full size (only the tidy rewrite remains).
    expect(engine.fileSize(docId)).toBeGreaterThan(before * 0.8);
  });

  it("leaves text-only files intact", () => {
    const { engine, docId } = open();
    const r = engine.compress(docId, PRESETS.print);
    expect(r.report.imagesResampled).toBe(0);
    expect(textOf(engine.save(docId))).toContain("quick brown fox");
  });
});

describe("repair", () => {
  it("rebuilds a damaged file and writes a clean one", () => {
    const good = fixture("sample.pdf");
    const s = Buffer.from(good).toString("latin1").replace(/startxref\s+\d+/, "startxref\n12345");
    const broken = new Uint8Array(Buffer.from(s, "latin1"));
    const engine = new PdfEngine();
    const r = engine.open(broken);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.info.repaired).toBe(true);
    const report = engine.repair(r.info.docId);
    expect(report).toMatchObject({ wasRepaired: true, pageCount: 5, brokenPages: [] });
    const fixed = engine.save(r.info.docId);
    const again = reopen(fixed).asPDF()!;
    expect(again.wasRepaired()).toBe(false);
    expect(again.countPages()).toBe(5);
  });

  it("reports healthy files as healthy", () => {
    const { engine, docId } = open();
    expect(engine.repair(docId)).toMatchObject({ wasRepaired: false, brokenPages: [] });
  });
});

function textOf(bytes: Uint8Array) {
  const d = reopen(bytes);
  return Array.from({ length: d.countPages() }, (_, i) => d.loadPage(i).toStructuredText("").asText()).join("\n");
}
