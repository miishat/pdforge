// Certificate (PAdES) signatures: signing with a PKCS#12 (.pfx/.p12) identity and verifying signatures.
// PKCS#12 parsing uses node-forge (it supports the legacy ciphers Windows still exports);
// CMS building and verification use PKI.js on WebCrypto.
import * as asn1js from "asn1js";
import * as mupdf from "mupdf";
import forge from "node-forge";
import * as pkijs from "pkijs";
import type { Rect } from "./types";

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sha256: "2.16.840.1.101.3.4.2.1",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  email: "1.2.840.113549.1.9.1",
};

/** Bytes reserved for the CMS signature (hex doubles it in the file). Room for long certificate chains. */
const SIGNATURE_SPACE = 16384;
const BYTE_RANGE_PLACEHOLDER = "[0 999999999 999999998 999999997]";

function cryptoEngine(): pkijs.CryptoEngine {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("This system doesn't provide the cryptography needed for signatures.");
  const engine = new pkijs.CryptoEngine({ name: "webcrypto", crypto: c });
  pkijs.setEngine("webcrypto", engine);
  return engine;
}

export interface Identity {
  name: string;
  email: string | null;
  organization: string | null;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** PKCS#8 DER of the private key. */
  key: Uint8Array;
  keyType: "RSA" | "EC";
  curve?: string;
  /** DER certificates, signer first. */
  chain: Uint8Array[];
}

/** Opens a .pfx/.p12 file. Throws a readable error for a wrong password or a file without a key. */
export function openIdentity(p12: Uint8Array, password: string): Identity {
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.createBuffer(bytesToBinary(p12));
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), password);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/password|MAC|Invalid/i.test(msg)) throw new Error("That password doesn't open this certificate file.");
    throw new Error(`This certificate file couldn't be read (${msg}).`);
  }
  const keyBag =
    parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ??
    parsed.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const certBags = parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  if (!keyBag) throw new Error("This certificate file has no private key, so it can't be used to sign.");
  if (!certBags.length) throw new Error("This certificate file has no certificate.");

  // Key → PKCS#8 DER. forge only models RSA keys; for EC keys use the raw bag ASN.1.
  let key: Uint8Array;
  let keyType: Identity["keyType"] = "RSA";
  if (keyBag.key) {
    const info = forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key));
    key = binaryToBytes(forge.asn1.toDer(info).getBytes());
  } else if (keyBag.asn1) {
    key = binaryToBytes(forge.asn1.toDer(keyBag.asn1).getBytes());
    keyType = "EC";
  } else throw new Error("This certificate's key type isn't supported.");

  // Put the certificate matching the key first.
  const certs = certBags.map((b) => binaryToBytes(forge.asn1.toDer(b.asn1 ? certAsn1(b) : forge.pki.certificateToAsn1(b.cert!)).getBytes()));
  const localId = keyBag.attributes?.localKeyId?.[0];
  const signerIdx = Math.max(0, certBags.findIndex((b) => localId && b.attributes?.localKeyId?.[0] === localId));
  const chain = [certs[signerIdx], ...certs.filter((_, i) => i !== signerIdx)];
  const cert = parseCert(chain[0]);
  return { ...describeCert(cert), key, keyType, curve: keyType === "EC" ? curveOf(key) : undefined, chain };
}

function certAsn1(b: forge.pkcs12.Bag): forge.asn1.Asn1 {
  return b.cert ? forge.pki.certificateToAsn1(b.cert) : (b.asn1 as forge.asn1.Asn1);
}

function curveOf(pkcs8: Uint8Array): string {
  const hex = Array.from(pkcs8.slice(0, 40), (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.includes("2b81040022")) return "P-384";
  if (hex.includes("2b81040023")) return "P-521";
  return "P-256";
}

function parseCert(der: Uint8Array): pkijs.Certificate {
  return pkijs.Certificate.fromBER(toArrayBuffer(der));
}

function nameField(name: pkijs.RelativeDistinguishedNames, oid: string): string | null {
  const tv = name.typesAndValues.find((t) => t.type === oid);
  return tv ? String(tv.value.valueBlock.value) : null;
}

function describeCert(cert: pkijs.Certificate) {
  const name = nameField(cert.subject, OID.commonName) ?? nameField(cert.subject, OID.organization) ?? "Unknown signer";
  return {
    name,
    email: nameField(cert.subject, OID.email),
    organization: nameField(cert.subject, OID.organization),
    issuer: nameField(cert.issuer, OID.commonName) ?? nameField(cert.issuer, OID.organization) ?? "Unknown issuer",
    validFrom: cert.notBefore.value.toISOString(),
    validTo: cert.notAfter.value.toISOString(),
  };
}

export interface SignOptions {
  pageIndex: number;
  /** Page-space rectangle for the visible signature; omit for an invisible signature. */
  rect?: Rect;
  reason?: string;
  location?: string;
  /** PNG of a handwritten signature to show in the appearance. */
  image?: Uint8Array;
  /** Signing time, for tests; defaults to now. */
  date?: Date;
}

/**
 * Adds a signature field to the document, saves it (incrementally when possible), and signs the
 * saved bytes. Returns the signed file.
 */
export async function signDocument(pdf: mupdf.PDFDocument, identity: Identity, opts: SignOptions): Promise<Uint8Array> {
  const date = opts.date ?? new Date();
  // The document's undo journal requires changes to happen inside an operation.
  pdf.beginOperation("Sign");
  try {
    addSignatureField(pdf, identity, opts, date);
    pdf.endOperation();
  } catch (err) {
    safe(() => pdf.abandonOperation(), undefined);
    throw err;
  }
  const incremental = safe(() => pdf.canBeSavedIncrementally(), false);
  const bytes = pdf.saveToBuffer(incremental ? "incremental" : "").asUint8Array().slice();
  return await embedSignature(bytes, identity, date);
}

function addSignatureField(pdf: mupdf.PDFDocument, identity: Identity, opts: SignOptions, date: Date) {
  const page = pdf.loadPage(opts.pageIndex);
  const pageObj = page.getObject();
  const S = (s: string) => pdf.newString(s);

  // Signature dictionary with fixed-width placeholders, patched after saving.
  const sig = pdf.addObject({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "ETSI.CAdES.detached",
    ByteRange: [0, 999999999, 999999998, 999999997],
    Contents: pdf.newByteString(new Uint8Array(SIGNATURE_SPACE)),
    M: S(pdfDate(date)),
    Name: S(identity.name),
    ...(opts.reason ? { Reason: S(opts.reason) } : {}),
    ...(opts.location ? { Location: S(opts.location) } : {}),
  });

  // Widget rectangle in PDF space.
  const toPdf = mupdf.Matrix.invert(page.getTransform());
  const r = opts.rect ? mupdf.Rect.transform(opts.rect, toPdf) : [0, 0, 0, 0];
  const pdfRect: Rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  const existing = countSignatureFields(pdf);
  const widget = pdf.addObject({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    T: S(`Signature${existing + 1}`),
    Rect: pdfRect,
    F: 132, // print + locked
    P: pageObj,
    V: sig,
  });
  if (opts.rect) widget.put("AP", { N: appearance(pdf, pdfRect, identity, date, opts) });

  let annots = pageObj.get("Annots");
  if (!annots.isArray()) {
    annots = pdf.newArray();
    pageObj.put("Annots", annots);
  }
  annots.push(widget);
  const root = pdf.getTrailer().get("Root");
  let acro = root.get("AcroForm");
  if (!acro.isDictionary()) {
    acro = pdf.newDictionary();
    root.put("AcroForm", acro);
  }
  let fields = acro.get("Fields");
  if (!fields.isArray()) {
    fields = pdf.newArray();
    acro.put("Fields", fields);
  }
  fields.push(widget);
  acro.put("SigFlags", 3);
}

async function embedSignature(bytes: Uint8Array, identity: Identity, date: Date): Promise<Uint8Array> {
  const text = bytesToBinary(bytes);
  const brAt = text.lastIndexOf(`/ByteRange${BYTE_RANGE_PLACEHOLDER}`);
  if (brAt < 0) throw new Error("Couldn't prepare the signature in the saved file.");
  const contentsAt = text.indexOf("/Contents<", brAt - SIGNATURE_SPACE * 2 - 200 > 0 ? brAt - SIGNATURE_SPACE * 2 - 200 : 0);
  const lt = text.indexOf("<", contentsAt);
  const gt = text.indexOf(">", lt);
  if (contentsAt < 0 || gt - lt - 1 !== SIGNATURE_SPACE * 2) throw new Error("Couldn't find the signature placeholder in the saved file.");

  const range = [0, lt, gt + 1, bytes.length - (gt + 1)];
  const brText = `[${range.join(" ")}]`.padEnd(BYTE_RANGE_PLACEHOLDER.length, " ");
  if (brText.length > BYTE_RANGE_PLACEHOLDER.length) throw new Error("This file is too large to sign.");
  const out = bytes.slice();
  out.set(binaryToBytes(brText), brAt + "/ByteRange".length);

  const signed = concat(out.subarray(0, range[1]), out.subarray(range[2]));
  const cms = await buildCms(signed, identity, date);
  if (cms.length > SIGNATURE_SPACE) throw new Error("The certificate chain is too large to fit in the signature.");
  const hex = Array.from(cms, (b) => b.toString(16).padStart(2, "0")).join("").padEnd(SIGNATURE_SPACE * 2, "0");
  out.set(binaryToBytes(hex), lt + 1);
  return out;
}

async function buildCms(data: Uint8Array, identity: Identity, _date: Date): Promise<Uint8Array> {
  const engine = cryptoEngine();
  const certs = identity.chain.map(parseCert);
  const signer = certs[0];
  const digest = new Uint8Array(await engine.digest({ name: "SHA-256" }, toArrayBuffer(data)));
  const certHash = new Uint8Array(await engine.digest({ name: "SHA-256" }, toArrayBuffer(identity.chain[0])));

  // ESS signing-certificate-v2 (required by PAdES): hash of the signer certificate (SHA-256 is the default algorithm).
  const essCertIdV2 = new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: toArrayBuffer(certHash) })] });
  const signingCertificateV2 = new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });

  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: signer.issuer, serialNumber: signer.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
            new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: toArrayBuffer(digest) })] }),
            new pkijs.Attribute({ type: OID.signingCertificateV2, values: [signingCertificateV2] }),
          ],
        }),
      }),
    ],
    certificates: certs,
  });

  const algorithm =
    identity.keyType === "RSA"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: identity.curve ?? "P-256", hash: "SHA-256" };
  const key = await engine.importKey("pkcs8", toArrayBuffer(identity.key), algorithm, false, ["sign"]);
  await signedData.sign(key, 0, "SHA-256");

  const content = new pkijs.ContentInfo({ contentType: OID.signedData, content: signedData.toSchema(true) });
  return new Uint8Array(content.toSchema().toBER(false));
}

export type SignatureStatus = "valid" | "modified" | "invalid" | "unsupported";

export interface SignatureInfo {
  field: string;
  page: number | null;
  status: SignatureStatus;
  /** Plain-language explanation of the status. */
  detail: string;
  signer: string;
  issuer: string | null;
  email: string | null;
  signedAt: string | null;
  reason: string | null;
  location: string | null;
  /** SHA-256 fingerprint of the signer certificate, for trust decisions. */
  fingerprint: string | null;
  selfSigned: boolean;
  certValidAtSigning: boolean | null;
  /** True when content was added to the file after this signature (e.g. later signatures or comments). */
  laterChanges: boolean;
}

/** Checks every signature in the file. `bytes` must be the exact file as stored on disk. */
export async function verifySignatures(pdf: mupdf.PDFDocument, bytes: Uint8Array): Promise<SignatureInfo[]> {
  const out: SignatureInfo[] = [];
  for (const { field, page, v } of signatureDicts(pdf)) {
    const str = (k: string) => safe(() => (v.get(k).isString() ? v.get(k).asString() : null), null);
    const base: SignatureInfo = {
      field,
      page,
      status: "unsupported",
      detail: "",
      signer: str("Name") ?? "Unknown signer",
      issuer: null,
      email: null,
      signedAt: parsePdfDate(str("M")),
      reason: str("Reason"),
      location: str("Location"),
      fingerprint: null,
      selfSigned: false,
      certValidAtSigning: null,
      laterChanges: false,
    };
    try {
      out.push(await verifyOne(v, bytes, base));
    } catch (err) {
      out.push({ ...base, status: "invalid", detail: `The signature couldn't be read (${(err as Error).message}).` });
    }
  }
  return out;
}

async function verifyOne(v: mupdf.PDFObject, bytes: Uint8Array, info: SignatureInfo): Promise<SignatureInfo> {
  const subFilter = safe(() => v.get("SubFilter").asName(), "");
  if (!["adbe.pkcs7.detached", "ETSI.CAdES.detached"].includes(subFilter)) {
    return { ...info, detail: `PDForge can't check signatures of type ${subFilter || "unknown"} yet.` };
  }
  const br = v.get("ByteRange");
  const range = [0, 1, 2, 3].map((i) => br.get(i).asNumber());
  if (range[0] !== 0 || range[1] < 0 || range[2] < range[1] || range[2] + range[3] > bytes.length) {
    return { ...info, status: "invalid", detail: "The signature's byte range doesn't match this file." };
  }
  const laterChanges = range[2] + range[3] < bytes.length;
  const signedBytes = concat(bytes.subarray(0, range[1]), bytes.subarray(range[2], range[2] + range[3]));
  const hex = bytesToBinary(bytes.subarray(range[1] + 1, range[2] - 1));
  const der = hexToBytes(hex.replace(/[^0-9a-fA-F]/g, ""));

  cryptoEngine();
  const asn = asn1js.fromBER(toArrayBuffer(der));
  if (asn.offset === -1) throw new Error("malformed signature data");
  const content = new pkijs.ContentInfo({ schema: asn.result });
  const signedData = new pkijs.SignedData({ schema: content.content });
  const signerInfo = signedData.signerInfos[0];
  const certs = (signedData.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  const sid = signerInfo.sid as pkijs.IssuerAndSerialNumber;
  const signer =
    certs.find((c) => c.serialNumber.isEqual(sid.serialNumber) && c.issuer.isEqual(sid.issuer)) ?? certs[0];
  if (!signer) throw new Error("no signer certificate");

  const described = describeCert(signer);
  const fingerprint = await sha256Hex(new Uint8Array(signer.toSchema().toBER(false)));
  const signingTimeAttr = signerInfo.signedAttrs?.attributes.find((a) => a.type === OID.signingTime);
  const signedAt = signingTimeAttr ? (signingTimeAttr.values[0] as asn1js.UTCTime).toDate().toISOString() : info.signedAt;
  const at = signedAt ? new Date(signedAt) : new Date();
  const certValid = at >= signer.notBefore.value && at <= signer.notAfter.value;

  let ok = false;
  try {
    ok = await signedData.verify({ signer: 0, data: toArrayBuffer(signedBytes), checkChain: false });
  } catch {
    ok = false;
  }

  const result: SignatureInfo = {
    ...info,
    signer: described.name,
    issuer: described.issuer,
    email: described.email,
    signedAt,
    fingerprint,
    selfSigned: signer.subject.isEqual(signer.issuer),
    certValidAtSigning: certValid,
    laterChanges,
  };
  if (!ok) return { ...result, status: "invalid", detail: "The document was altered after it was signed, or the signature is damaged." };
  if (laterChanges)
    return { ...result, status: "modified", detail: "The signed version is intact, but the file was changed afterwards (for example, comments or another signature were added)." };
  return { ...result, status: "valid", detail: "The document hasn't been changed since it was signed." };
}

function signatureDicts(pdf: mupdf.PDFDocument): { field: string; page: number | null; v: mupdf.PDFObject }[] {
  const out: { field: string; page: number | null; v: mupdf.PDFObject }[] = [];
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    const page = pdf.loadPage(p);
    for (const w of safe(() => page.getWidgets(), [])) {
      if (safe(() => w.getFieldType(), "") !== "signature") continue;
      let f = w.getObject();
      for (let i = 0; i < 5 && !f.get("V").isDictionary() && f.get("Parent").isDictionary(); i++) f = f.get("Parent");
      const v = f.get("V");
      if (v.isDictionary()) out.push({ field: safe(() => w.getName(), "Signature"), page: p, v });
    }
    page.destroy();
  }
  return out;
}

function countSignatureFields(pdf: mupdf.PDFDocument): number {
  let n = 0;
  safe(() => {
    const fields = pdf.getTrailer().get("Root").get("AcroForm").get("Fields");
    for (let i = 0; i < fields.length; i++) if (safe(() => fields.get(i).get("FT").asName(), "") === "Sig") n++;
  }, undefined);
  return n;
}

/** The visible signature: optional handwritten image on the left, signer details on the right. */
function appearance(pdf: mupdf.PDFDocument, r: Rect, id: Identity, date: Date, opts: SignOptions): mupdf.PDFObject {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const font = pdf.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
  const resources: Record<string, unknown> = { Font: { Helv: font } };
  let content = "";
  let textX = 4;
  if (opts.image) {
    const img = new mupdf.Image(opts.image);
    const iw = img.getWidth();
    const ih = img.getHeight();
    const boxW = w * 0.45;
    const s = Math.min(boxW / iw, (h - 4) / ih);
    const dw = iw * s;
    const dh = ih * s;
    resources.XObject = { Sig: pdf.addImage(img) };
    content += `q ${num(dw)} 0 0 ${num(dh)} ${num(2 + (boxW - dw) / 2)} ${num((h - dh) / 2)} cm /Sig Do Q\n`;
    textX = boxW + 8;
  }
  const lines = [`Digitally signed by ${id.name}`, `Date: ${displayDate(date)}`];
  if (opts.reason) lines.push(`Reason: ${opts.reason}`);
  if (opts.location) lines.push(`Location: ${opts.location}`);
  const availW = w - textX - 4;
  const longest = Math.max(...lines.map((l) => l.length));
  const size = Math.max(4, Math.min(10, h / (lines.length * 1.3 + 0.5), availW / (longest * 0.5)));
  content += `BT /Helv ${num(size)} Tf 0 g ${num(textX)} ${num(h - size * 1.2)} Td ${num(size * 1.25)} TL\n`;
  lines.forEach((l, i) => (content += `${i ? "T* " : ""}(${pdfEscape(l)}) Tj\n`));
  content += "ET";
  return pdf.addStream(content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: resources });
}

function num(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function pdfEscape(s: string): string {
  // Helvetica with WinAnsi: keep Latin-1; replace anything else.
  return s.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\xff]/g, "?");
}

export function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
}

function parsePdfDate(s: string | null): string | null {
  if (!s) return null;
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(s);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", tz = "Z"] = m;
  const zone = tz === "Z" ? "Z" : `${tz.slice(0, 3)}:${tz.replace(/'/g, "").slice(3, 5) || "00"}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function displayDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(b)));
  return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join(":").toUpperCase();
}

function bytesToBinary(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
