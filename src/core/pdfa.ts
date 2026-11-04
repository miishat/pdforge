// PDF/A-2b (ISO 19005-2, level B): checks for the common requirements, and fixes for the ones
// that can be fixed automatically. This isn't a certified validator: the report says which
// checks were made, and veraPDF remains the reference for official validation.
import * as mupdf from "mupdf";
import { srgbProfile } from "./icc";
import { WIN_ANSI } from "./stamping";

export type CheckStatus = "pass" | "fixed" | "fail" | "warn";

export interface PdfACheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface PdfAReport {
  /** What the file's own metadata claims, e.g. "PDF/A-2B", or null. */
  claims: string | null;
  checks: PdfACheck[];
  /** True when no check failed. */
  ok: boolean;
}

const BASE14: Record<string, string> = {
  Helvetica: "Helvetica", "Helvetica-Bold": "Helvetica-Bold", "Helvetica-Oblique": "Helvetica-Oblique", "Helvetica-BoldOblique": "Helvetica-BoldOblique",
  "Times-Roman": "Times-Roman", "Times-Bold": "Times-Bold", "Times-Italic": "Times-Italic", "Times-BoldItalic": "Times-BoldItalic",
  Courier: "Courier", "Courier-Bold": "Courier-Bold", "Courier-Oblique": "Courier-Oblique", "Courier-BoldOblique": "Courier-BoldOblique",
  // Common TrueType names for the same designs.
  Arial: "Helvetica", "Arial,Bold": "Helvetica-Bold", "Arial,Italic": "Helvetica-Oblique", "Arial,BoldItalic": "Helvetica-BoldOblique",
  ArialMT: "Helvetica", "Arial-BoldMT": "Helvetica-Bold", "Arial-ItalicMT": "Helvetica-Oblique", "Arial-BoldItalicMT": "Helvetica-BoldOblique",
  TimesNewRoman: "Times-Roman", "TimesNewRoman,Bold": "Times-Bold", "TimesNewRoman,Italic": "Times-Italic", "TimesNewRoman,BoldItalic": "Times-BoldItalic",
  TimesNewRomanPSMT: "Times-Roman", "TimesNewRomanPS-BoldMT": "Times-Bold", "TimesNewRomanPS-ItalicMT": "Times-Italic", "TimesNewRomanPS-BoldItalicMT": "Times-BoldItalic",
  CourierNew: "Courier", "CourierNew,Bold": "Courier-Bold", CourierNewPSMT: "Courier", "CourierNewPS-BoldMT": "Courier-Bold",
};

const FORBIDDEN_ACTIONS = new Set(["Launch", "Sound", "Movie", "ResetForm", "ImportData", "JavaScript", "Hide", "SetOCGState", "Rendition", "Trans", "GoTo3DView"]);
const HIDDEN_FLAGS = 1 | 2 | 32 | 256; // Invisible, Hidden, NoView, ToggleNoView

interface Context {
  pdf: mupdf.PDFDocument;
  fix: boolean;
  checks: PdfACheck[];
}

/** Checks the document; with `fix`, also changes it to meet the requirements it can. */
export function pdfA(pdf: mupdf.PDFDocument, opts: { fix: boolean; encrypted: boolean; signed: boolean }): PdfAReport {
  const ctx: Context = { pdf, fix: opts.fix, checks: [] };
  const claims = claimed(pdf);
  ctx.checks.push(
    opts.encrypted
      ? { id: "encryption", label: "Not encrypted", status: "fail", detail: "PDF/A files can't be encrypted. Remove the password and restrictions first (Protect → Security)." }
      : { id: "encryption", label: "Not encrypted", status: "pass" },
  );
  // Annotations first: giving them appearances can add fonts, which the font check then embeds.
  checkActions(ctx);
  checkAttachments(ctx);
  checkAnnotations(ctx);
  checkForms(ctx);
  checkFonts(ctx);
  checkOutputIntent(ctx);
  checkImagesAndStreams(ctx);
  checkColour(ctx);
  checkLayers(ctx);
  checkPageBoxes(ctx);
  checkMetadata(ctx, claims);
  if (opts.signed) {
    ctx.checks.push({ id: "signatures", label: "Signatures", status: "warn", detail: opts.fix ? "Converting changed the file, so its existing signatures no longer cover it." : "Converting will invalidate the existing signatures." });
  }
  return { claims: opts.fix ? "PDF/A-2B" : claims, checks: ctx.checks, ok: !ctx.checks.some((c) => c.status === "fail") };
}

function claimed(pdf: mupdf.PDFDocument): string | null {
  const xmp = readMetadata(pdf);
  if (!xmp) return null;
  const part = /pdfaid:part(?:>|=")\s*(\d)/.exec(xmp)?.[1];
  const conf = /pdfaid:conformance(?:>|=")\s*([ABU])/i.exec(xmp)?.[1];
  return part ? `PDF/A-${part}${(conf ?? "").toUpperCase()}` : null;
}

function readMetadata(pdf: mupdf.PDFDocument): string | null {
  const m = pdf.getTrailer().get("Root").get("Metadata");
  if (!m.isStream()) return null;
  try {
    return m.readStream().asString();
  } catch {
    return null;
  }
}

function each(pdf: mupdf.PDFDocument, fn: (obj: mupdf.PDFObject, num: number) => void) {
  const n = pdf.countObjects();
  for (let i = 1; i < n; i++) {
    const ref = pdf.newIndirect(i);
    const r = ref.resolve();
    if (r.isDictionary() || ref.isStream()) fn(ref, i);
  }
}

const nameOf = (o: mupdf.PDFObject, key: string) => {
  const v = o.get(key);
  return v.isName() ? v.asName() : "";
};

// ---- Fonts ----

function checkFonts(ctx: Context) {
  const { pdf } = ctx;
  const missing: string[] = [];
  const fixable: string[] = [];
  const replaced: string[] = [];
  each(pdf, (ref) => {
    if (nameOf(ref, "Type") !== "Font") return;
    const sub = nameOf(ref, "Subtype");
    if (sub === "Type3" || sub === "CIDFontType0" || sub === "CIDFontType2") return; // descendants are checked via their Type0 parent
    const base = nameOf(ref, "BaseFont").replace(/^[A-Z]{6}\+/, "");
    const desc = sub === "Type0" ? ref.get("DescendantFonts").get(0).get("FontDescriptor") : ref.get("FontDescriptor");
    const embedded = desc.isDictionary() && ["FontFile", "FontFile2", "FontFile3"].some((k) => desc.get(k).isStream());
    if (embedded) return;
    const std = sub !== "Type0" ? BASE14[base] : undefined;
    if (std && ctx.fix && embedStandard(pdf, ref, std)) replaced.push(base);
    else if (std && !ctx.fix) fixable.push(base);
    else missing.push(base || "Unnamed font");
  });
  const uniq = (a: string[]) => [...new Set(a)].join(", ");
  const label = "All fonts embedded";
  if (missing.length) {
    const also = fixable.length ? ` (${uniq(fixable)} can be embedded automatically.)` : "";
    ctx.checks.push({ id: "fonts", label, status: "fail", detail: `Not embedded: ${uniq(missing)}. These need the original font files: re-create the PDF with font embedding turned on.${also}` });
  } else if (fixable.length) {
    ctx.checks.push({ id: "fonts", label, status: "fail", detail: `Not embedded: ${uniq(fixable)}. Converting embeds matching fonts.` });
  } else if (replaced.length) {
    ctx.checks.push({ id: "fonts", label, status: "fixed", detail: `Embedded metric-compatible versions of ${uniq(replaced)}.` });
  } else {
    ctx.checks.push({ id: "fonts", label, status: "pass" });
  }
}

/**
 * Replaces an unembedded standard font with MuPDF's built-in, metric-compatible equivalent
 * (the URW Nimbus fonts), embedded as a WinAnsi simple font so the page's character codes still work.
 */
function embedStandard(pdf: mupdf.PDFDocument, ref: mupdf.PDFObject, std: string): boolean {
  try {
    const enc = ref.get("Encoding");
    const encName = enc.isName() ? enc.asName() : enc.isDictionary() ? "custom" : "";
    // The replacement uses WinAnsi codes; other encodings could change which glyphs appear.
    if (encName && encName !== "WinAnsiEncoding" && encName !== "StandardEncoding") return false;
    const file = standardFontFile(pdf, std);
    if (!file) return false;
    const font = new mupdf.Font(std);
    const unicodeOf = new Map<number, number>();
    for (const [uni, code] of Object.entries(WIN_ANSI)) unicodeOf.set(code, Number(uni));
    const widths = pdf.newArray();
    for (let code = 32; code <= 255; code++) {
      const uni = code >= 0x80 && code <= 0x9f ? unicodeOf.get(code) : code === 0x7f ? undefined : code;
      const gid = uni === undefined ? 0 : font.encodeCharacter(uni);
      widths.push(gid > 0 ? Math.round(font.advanceGlyph(gid) * 1000) : 0);
    }
    const desc = file.descriptor;
    let flags = 32; // nonsymbolic
    if (font.isMono()) flags |= 1;
    if (font.isSerif()) flags |= 2;
    if (font.isItalic()) flags |= 64;
    desc.put("Flags", flags);
    desc.put("FontName", pdf.newName(std));
    const keys: string[] = [];
    ref.resolve().forEach((_v, k) => keys.push(String(k)));
    for (const k of keys) ref.delete(k);
    ref.put("Type", pdf.newName("Font"));
    ref.put("Subtype", pdf.newName("Type1"));
    ref.put("BaseFont", pdf.newName(std));
    ref.put("FirstChar", 32);
    ref.put("LastChar", 255);
    ref.put("Widths", widths);
    ref.put("Encoding", pdf.newName("WinAnsiEncoding"));
    ref.put("FontDescriptor", desc);
    return true;
  } catch {
    return false;
  }
}

/** The built-in font's CFF program and a descriptor for it, borrowed from MuPDF's CID-font writer. */
function standardFontFile(pdf: mupdf.PDFDocument, std: string): { descriptor: mupdf.PDFObject } | null {
  const scratch = pdf.addFont(new mupdf.Font(std)).resolve();
  const desc = scratch.get("DescendantFonts").get(0).get("FontDescriptor");
  const ff = desc.get("FontFile3");
  if (!ff.isStream()) return null;
  const data = ff.readStream();
  const program = pdf.addStream(data, { Subtype: pdf.newName("Type1C") });
  const fresh = pdf.addObject(pdf.newDictionary());
  desc.forEach((v, k) => {
    if (String(k) !== "FontFile3") fresh.put(String(k), v);
  });
  fresh.put("FontFile3", program);
  return { descriptor: fresh };
}

// ---- Output intent (colour) ----

function checkOutputIntent(ctx: Context) {
  const { pdf } = ctx;
  const root = pdf.getTrailer().get("Root");
  const intents = root.get("OutputIntents");
  let has = false;
  if (intents.isArray()) {
    for (let i = 0; i < intents.length; i++) {
      const oi = intents.get(i);
      if (nameOf(oi, "S") === "GTS_PDFA1" && oi.get("DestOutputProfile").isStream()) has = true;
    }
  }
  if (has) return ctx.checks.push({ id: "intent", label: "Colour profile (output intent)", status: "pass" });
  if (!ctx.fix) return ctx.checks.push({ id: "intent", label: "Colour profile (output intent)", status: "fail", detail: "No PDF/A output intent; an sRGB profile can be added." });
  const profile = pdf.addStream(srgbProfile(), { N: 3 });
  const intent = pdf.addObject({
    Type: pdf.newName("OutputIntent"),
    S: pdf.newName("GTS_PDFA1"),
    OutputConditionIdentifier: pdf.newString("sRGB IEC61966-2.1"),
    Info: pdf.newString("sRGB IEC61966-2.1"),
    RegistryName: pdf.newString("http://www.color.org"),
    DestOutputProfile: profile,
  });
  const arr = pdf.newArray();
  arr.push(intent);
  root.put("OutputIntents", arr);
  ctx.checks.push({ id: "intent", label: "Colour profile (output intent)", status: "fixed", detail: "Added an sRGB output intent." });
}

// ---- Scripts and actions ----

function checkActions(ctx: Context) {
  const { pdf } = ctx;
  let found = 0;
  const root = pdf.getTrailer().get("Root");
  const names = root.get("Names");
  if (names.isDictionary() && !names.get("JavaScript").isNull()) {
    found++;
    if (ctx.fix) names.delete("JavaScript");
  }
  const badAction = (a: mupdf.PDFObject) => a.isDictionary() && FORBIDDEN_ACTIONS.has(nameOf(a, "S"));
  const oa = root.get("OpenAction");
  if (badAction(oa)) {
    found++;
    if (ctx.fix) root.delete("OpenAction");
  }
  each(pdf, (ref) => {
    const r = ref.resolve();
    // Additional actions (on open, close, page view, field events) aren't allowed in PDF/A-2.
    if (!r.get("AA").isNull()) {
      found++;
      if (ctx.fix) ref.delete("AA");
    }
    if (badAction(r.get("A"))) {
      found++;
      if (ctx.fix) ref.delete("A");
    }
  });
  ctx.checks.push(
    found === 0
      ? { id: "actions", label: "No scripts or launch actions", status: "pass" }
      : { id: "actions", label: "No scripts or launch actions", status: ctx.fix ? "fixed" : "fail", detail: `${found} script${found === 1 ? "" : "s"} or forbidden action${found === 1 ? "" : "s"}${ctx.fix ? " removed" : ""}.` },
  );
}

function checkAttachments(ctx: Context) {
  const files = Object.keys(ctx.pdf.getEmbeddedFiles());
  let fileAnnots = 0;
  each(ctx.pdf, (ref) => {
    if (nameOf(ref, "Subtype") === "FileAttachment") fileAnnots++;
  });
  if (!files.length && !fileAnnots) return ctx.checks.push({ id: "attachments", label: "No attachments", status: "pass" });
  const list = files.join(", ") || `${fileAnnots} attached file comment${fileAnnots === 1 ? "" : "s"}`;
  if (!ctx.fix) {
    return ctx.checks.push({ id: "attachments", label: "No attachments", status: "fail", detail: `PDF/A-2 allows only PDF/A attachments. Converting removes: ${list}. Save them first if you need them.` });
  }
  for (const name of files) ctx.pdf.deleteEmbeddedFile(name);
  for (let p = 0; p < ctx.pdf.countPages(); p++) {
    const page = ctx.pdf.loadPage(p);
    for (const a of page.getAnnotations()) if (a.getType() === "FileAttachment") page.deleteAnnotation(a);
    page.destroy();
  }
  ctx.checks.push({ id: "attachments", label: "No attachments", status: "fixed", detail: `Removed: ${list}.` });
}

// ---- Annotations and forms ----

function checkAnnotations(ctx: Context) {
  const { pdf } = ctx;
  let flags = 0;
  let appearances = 0;
  let unfixed = 0;
  for (let p = 0; p < pdf.countPages(); p++) {
    const page = pdf.loadPage(p);
    for (const annot of [...page.getAnnotations(), ...page.getWidgets()]) {
      const obj = annot.getObject();
      const sub = nameOf(obj, "Subtype");
      if (sub === "Popup") continue;
      const f = obj.get("F").isNumber() ? obj.get("F").asNumber() : 0;
      if ((f & 4) === 0 || (f & HIDDEN_FLAGS) !== 0) {
        flags++;
        if (ctx.fix) obj.put("F", (f | 4) & ~HIDDEN_FLAGS);
      }
      if (sub !== "Link" && !obj.get("AP").get("N").isStream() && !obj.get("AP").get("N").isDictionary()) {
        appearances++;
        if (ctx.fix) {
          try {
            annot.update();
          } catch {
            // counted below
          }
          if (!obj.get("AP").get("N").isStream() && !obj.get("AP").get("N").isDictionary()) unfixed++;
        }
      }
      // Appearance dictionaries may only hold the normal appearance.
      const ap = obj.get("AP");
      if (ctx.fix && ap.isDictionary() && sub !== "Widget") {
        ap.delete("R");
        ap.delete("D");
      }
    }
    page.destroy();
  }
  const total = flags + appearances;
  if (total === 0) return ctx.checks.push({ id: "annotations", label: "Comments print and have appearances", status: "pass" });
  if (!ctx.fix) {
    return ctx.checks.push({ id: "annotations", label: "Comments print and have appearances", status: "fail", detail: `${flags} comment${flags === 1 ? "" : "s"} hidden or not set to print; ${appearances} without an appearance.` });
  }
  ctx.checks.push(
    unfixed
      ? { id: "annotations", label: "Comments print and have appearances", status: "fail", detail: `${unfixed} comment${unfixed === 1 ? "" : "s"} couldn't be given an appearance.` }
      : { id: "annotations", label: "Comments print and have appearances", status: "fixed", detail: `Updated ${total} comment${total === 1 ? "" : "s"} and field${total === 1 ? "" : "s"}.` },
  );
}

function checkForms(ctx: Context) {
  const form = ctx.pdf.getTrailer().get("Root").get("AcroForm");
  if (!form.isDictionary()) return;
  const xfa = !form.get("XFA").isNull();
  const need = form.get("NeedAppearances").isBoolean() && form.get("NeedAppearances").asBoolean();
  if (!xfa && !need) return ctx.checks.push({ id: "forms", label: "Form fields are self-contained", status: "pass" });
  if (ctx.fix) {
    form.delete("XFA");
    form.delete("NeedAppearances");
  }
  ctx.checks.push({ id: "forms", label: "Form fields are self-contained", status: ctx.fix ? "fixed" : "fail", detail: [xfa && "XFA form data", need && "fields drawn by the viewer"].filter(Boolean).join(" and ") + (ctx.fix ? " removed." : " aren't allowed.") });
}

// ---- Streams ----

function checkImagesAndStreams(ctx: Context) {
  let lzw = 0;
  let interp = 0;
  let external = 0;
  each(ctx.pdf, (ref) => {
    const r = ref.resolve();
    if (ref.isStream()) {
      const f = r.get("Filter");
      const names = f.isName() ? [f.asName()] : f.isArray() ? Array.from({ length: f.length }, (_, i) => f.get(i).asName()) : [];
      if (names.includes("LZWDecode")) {
        lzw++;
        if (ctx.fix) {
          // Decode and store again; the save compresses it with Flate.
          const data = ref.readStream();
          ref.delete("DecodeParms");
          ref.writeStream(data);
        }
      }
      if (!r.get("F").isNull() && r.get("Length").isNumber()) {
        external++;
      }
    }
    if (r.get("Interpolate").isBoolean() && r.get("Interpolate").asBoolean()) {
      interp++;
      if (ctx.fix) ref.delete("Interpolate");
    }
    if (nameOf(r, "Subtype") === "Image" && !r.get("Alternates").isNull()) {
      interp++;
      if (ctx.fix) ref.delete("Alternates");
    }
  });
  const fixedCount = lzw + interp;
  if (external) ctx.checks.push({ id: "external", label: "No external content", status: "fail", detail: `${external} stream${external === 1 ? "" : "s"} refer to external files.` });
  ctx.checks.push(
    fixedCount === 0
      ? { id: "streams", label: "Allowed compression and image options", status: "pass" }
      : { id: "streams", label: "Allowed compression and image options", status: ctx.fix ? "fixed" : "fail", detail: `${lzw ? `${lzw} LZW-compressed stream${lzw === 1 ? "" : "s"}` : ""}${lzw && interp ? "; " : ""}${interp ? `${interp} image${interp === 1 ? "" : "s"} with interpolation or alternates` : ""}.` },
  );
}

function checkColour(ctx: Context) {
  const { pdf } = ctx;
  let cmykImages = 0;
  let cmykContent = 0;
  each(pdf, (ref) => {
    const r = ref.resolve();
    if (nameOf(r, "Subtype") === "Image" && nameOf(r, "ColorSpace") === "DeviceCMYK") {
      cmykImages++;
      if (ctx.fix && ref.isStream()) {
        try {
          const img = pdf.loadImage(ref);
          const rgb = img.toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
          ref.writeRawStream(rgb.asJPEG(92));
          ref.put("Filter", pdf.newName("DCTDecode"));
          ref.put("ColorSpace", pdf.newName("DeviceRGB"));
          ref.put("BitsPerComponent", 8);
          ref.delete("Decode");
          ref.delete("DecodeParms");
          cmykImages--;
        } catch {
          // stays counted
        }
      }
    }
  });
  for (let p = 0; p < pdf.countPages(); p++) {
    const page = pdf.loadPage(p);
    try {
      const contents = page.getObject().get("Contents");
      const streams = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents];
      for (const s of streams) {
        if (!s.isStream()) continue;
        const text = s.readStream().asString();
        if (/(^|\s)[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[kK](\s|$)/.test(text) || /\/DeviceCMYK\s+(cs|CS)/.test(text)) cmykContent++;
      }
    } catch {
      // unreadable content is reported by other checks
    }
    page.destroy();
  }
  if (!cmykImages && !cmykContent) return ctx.checks.push({ id: "colour", label: "Colours match the output intent", status: "pass" });
  ctx.checks.push({
    id: "colour",
    label: "Colours match the output intent",
    status: cmykContent ? "fail" : ctx.fix ? "fixed" : "fail",
    detail: cmykContent
      ? `${cmykContent} page${cmykContent === 1 ? "" : "s"} use CMYK colours, which need a CMYK output profile. Export from the original application as PDF/A instead.`
      : "CMYK images were converted to RGB.",
  });
}

function checkLayers(ctx: Context) {
  const oc = ctx.pdf.getTrailer().get("Root").get("OCProperties");
  if (!oc.isDictionary()) return;
  const configs = [oc.get("D")];
  const extra = oc.get("Configs");
  if (extra.isArray()) for (let i = 0; i < extra.length; i++) configs.push(extra.get(i));
  let unnamed = 0;
  configs.forEach((c, i) => {
    if (c.isDictionary() && !c.get("Name").isString()) {
      unnamed++;
      if (ctx.fix) c.put("Name", ctx.pdf.newString(i === 0 ? "Default" : `Configuration ${i}`));
    }
    if (ctx.fix && c.isDictionary()) c.delete("AS");
  });
  ctx.checks.push(unnamed ? { id: "layers", label: "Layer settings are named", status: ctx.fix ? "fixed" : "fail" } : { id: "layers", label: "Layer settings are named", status: "pass" });
}

function checkPageBoxes(ctx: Context) {
  let bad = 0;
  for (let p = 0; p < ctx.pdf.countPages(); p++) {
    const page = ctx.pdf.loadPage(p);
    const [x0, y0, x1, y1] = page.getBounds("MediaBox");
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 3 || h < 3 || w > 14400 || h > 14400) bad++;
    page.destroy();
  }
  ctx.checks.push(bad ? { id: "pages", label: "Page sizes within limits", status: "fail", detail: `${bad} page${bad === 1 ? "" : "s"} smaller than 3 pt or larger than 200 in.` } : { id: "pages", label: "Page sizes within limits", status: "pass" });
}

// ---- Metadata ----

function checkMetadata(ctx: Context, claims: string | null) {
  const { pdf } = ctx;
  if (!ctx.fix) {
    ctx.checks.push(
      claims
        ? { id: "metadata", label: "PDF/A identification in metadata", status: "pass", detail: `The file says it is ${claims}.` }
        : { id: "metadata", label: "PDF/A identification in metadata", status: "fail", detail: "The file's metadata doesn't identify it as PDF/A; converting adds it." },
    );
    return;
  }
  const trailer = pdf.getTrailer();
  let info = trailer.get("Info");
  if (!info.isDictionary()) {
    info = pdf.addObject(pdf.newDictionary());
    trailer.put("Info", info);
  }
  const str = (k: string) => (info.get(k).isString() ? info.get(k).asString() : "");
  const now = new Date();
  const created = parsePdfDate(str("CreationDate")) ?? now;
  const pdfDate = (d: Date) => `D:${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
  info.put("CreationDate", pdf.newString(pdfDate(created)));
  info.put("ModDate", pdf.newString(pdfDate(now)));
  const producer = str("Producer") || "PDForge";
  info.put("Producer", pdf.newString(producer));
  // Trapped must be absent or a name; PDF/A-2 doesn't need it.
  if (info.get("Trapped").isString()) info.delete("Trapped");
  const xmp = buildXmp({
    title: str("Title"), author: str("Author"), subject: str("Subject"), keywords: str("Keywords"),
    creator: str("Creator"), producer, created, modified: now,
  });
  const meta = pdf.addStream(new TextEncoder().encode(xmp), { Type: pdf.newName("Metadata"), Subtype: pdf.newName("XML") });
  trailer.get("Root").put("Metadata", meta);
  ctx.checks.push({ id: "metadata", label: "PDF/A identification in metadata", status: "fixed", detail: "Wrote XMP metadata identifying the file as PDF/A-2b, matching the document properties." });
}

/** Whether the document has filled signature fields. */
export function hasSignatures(pdf: mupdf.PDFDocument): boolean {
  let found = false;
  each(pdf, (ref) => {
    if (!found && nameOf(ref, "FT") === "Sig" && ref.get("V").isDictionary()) found = true;
  });
  return found;
}

export function buildXmp(m: { title: string; author: string; subject: string; keywords: string; creator: string; producer: string; created: Date; modified: Date }): string {
  const x = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const alt = (tag: string, v: string) => (v ? `<${tag}><rdf:Alt><rdf:li xml:lang="x-default">${x(v)}</rdf:li></rdf:Alt></${tag}>` : "");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<pdfaid:part>2</pdfaid:part>
<pdfaid:conformance>B</pdfaid:conformance>
<dc:format>application/pdf</dc:format>
${alt("dc:title", m.title)}
${m.author ? `<dc:creator><rdf:Seq><rdf:li>${x(m.author)}</rdf:li></rdf:Seq></dc:creator>` : ""}
${alt("dc:description", m.subject)}
${m.keywords ? `<pdf:Keywords>${x(m.keywords)}</pdf:Keywords>` : ""}
<pdf:Producer>${x(m.producer)}</pdf:Producer>
${m.creator ? `<xmp:CreatorTool>${x(m.creator)}</xmp:CreatorTool>` : ""}
<xmp:CreateDate>${iso(m.created)}</xmp:CreateDate>
<xmp:ModifyDate>${iso(m.modified)}</xmp:ModifyDate>
<xmp:MetadataDate>${iso(m.modified)}</xmp:MetadataDate>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
${" ".repeat(2000)}
<?xpacket end="w"?>`;
}

function parsePdfDate(v: string): Date | null {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(v);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date;
}
