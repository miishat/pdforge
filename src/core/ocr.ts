// OCR support on the PDF side: renders pages for recognition, and lays the recognised text
// over each page as an invisible layer (so scans become searchable and selectable).
// Recognition itself runs in Tesseract (see src/ui/ocr), which returns a text-only PDF page
// per image: invisible text (render mode 3) in an embedded glyph-less font.
import * as mupdf from "mupdf";

const OCR_KEY = "PDForgeOCR";
const XOBJECT = "PDFgOCR";

export interface OcrPage {
  page: number;
  /** Tesseract's text-only PDF for the page image. */
  pdf: Uint8Array;
  /** Skew Tesseract corrected for, in radians (clockwise positive, as Leptonica rotates). */
  rotateRadians?: number;
  /** Straighten the page content by the same angle, so it lines up with the recognised text. */
  deskew?: boolean;
}

/** The page as a grey PNG for recognition (content only: comments and fields would confuse OCR). */
export function ocrImage(page: mupdf.PDFPage, dpi: number): Uint8Array {
  const scale = dpi / 72;
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, false, "View");
  pix.setResolution(dpi, dpi);
  const png = pix.asPNG().slice();
  pix.destroy();
  return png;
}

/** True when the page already has real text (enough that it doesn't look like a scan). */
export function hasText(page: mupdf.PDFPage): boolean {
  const st = page.toStructuredText("");
  const n = st.asText().replace(/\s+/g, "").length;
  st.destroy();
  return n >= 20;
}

export function hasOcrLayer(page: mupdf.PDFPage): boolean {
  return page.getObject().get(OCR_KEY).isStream();
}

/** Adds (or replaces) the recognised text layer of a page. */
export function addOcrLayer(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, item: OcrPage) {
  removeOcrLayer(pdf, page);
  const obj = page.getObject();
  if (item.deskew && item.rotateRadians && Math.abs(item.rotateRadians) > 0.001) straighten(pdf, page, item.rotateRadians);

  const src = mupdf.Document.openDocument(item.pdf, "application/pdf").asPDF();
  if (!src || src.countPages() < 1) throw new Error("The recognised text couldn't be read.");
  const sp = src.loadPage(0) as mupdf.PDFPage;
  const sobj = sp.getObject();
  const [sx0, sy0, sx1, sy1] = sp.getBounds();
  const content = readContents(sobj);
  const resources = pdf.graftObject(sobj.get("Resources"));
  sp.destroy();
  src.destroy();

  // Tesseract's page is the image (y up, in points at the image's resolution); the rendered image
  // was the page as displayed. Map image space → displayed page space → the page's own space.
  const [px0, py0, px1, py1] = page.getBounds();
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  const scaleX = (px1 - px0) / sw;
  const scaleY = (py1 - py0) / sh;
  const toDisplayed: mupdf.Matrix = [scaleX, 0, 0, -scaleY, px0, py1];
  const fromDisplayed = mupdf.Matrix.invert(page.getTransform());
  const matrix = mupdf.Matrix.concat(toDisplayed, fromDisplayed);

  const form = pdf.addStream(content, {
    Type: pdf.newName("XObject"),
    Subtype: pdf.newName("Form"),
    BBox: [sx0, sy0, sx1, sy1],
    Matrix: matrix,
    Resources: resources,
  });
  const res = ownResources(pdf, obj);
  let xo = res.get("XObject");
  if (!xo.isDictionary()) {
    xo = pdf.newDictionary();
    res.put("XObject", xo);
  }
  xo.put(XOBJECT, form);
  const stream = pdf.addStream(`q /${XOBJECT} Do Q\n`, {});
  const list = contentList(pdf, obj);
  list.push(stream);
  obj.put("Contents", list);
  obj.put(OCR_KEY, stream);
}

/** Removes a text layer added by OCR. Returns whether there was one. */
export function removeOcrLayer(pdf: mupdf.PDFDocument, page: mupdf.PDFPage): boolean {
  const obj = page.getObject();
  const marker = obj.get(OCR_KEY);
  if (!marker.isStream()) return false;
  const num = marker.asIndirect();
  const list = contentList(pdf, obj);
  const kept = pdf.newArray();
  for (let i = 0; i < list.length; i++) {
    const c = list.get(i);
    if (!(c.isIndirect() && c.asIndirect() === num)) kept.push(c);
  }
  obj.put("Contents", kept);
  const xo = obj.get("Resources").get("XObject");
  if (xo.isDictionary()) xo.delete(XOBJECT);
  obj.delete(OCR_KEY);
  return true;
}

/** Rotates the page's content about the centre of its visible area. */
function straighten(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, radians: number) {
  const obj = page.getObject();
  // The visible area's centre, in the page's own coordinates.
  const [x0, y0, x1, y1] = page.getBounds();
  const inv = mupdf.Matrix.invert(page.getTransform());
  const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const cx = inv[0] * mx + inv[2] * my + inv[4];
  const cy = inv[1] * mx + inv[3] * my + inv[5];
  // Leptonica turns the image clockwise by `radians` (y down). In PDF space (y up) the same
  // visual turn is a rotation by -radians; page /Rotate doesn't change the sense of a turn.
  const c = Math.cos(-radians);
  const s = Math.sin(-radians);
  const m = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy].map((v) => +v.toFixed(6));
  const list = contentList(pdf, obj);
  const wrapped = pdf.newArray();
  wrapped.push(pdf.addStream(`q ${m.join(" ")} cm\n`, {}));
  for (let i = 0; i < list.length; i++) wrapped.push(list.get(i));
  wrapped.push(pdf.addStream("\nQ\n", {}));
  obj.put("Contents", wrapped);
}

function contentList(pdf: mupdf.PDFDocument, obj: mupdf.PDFObject): mupdf.PDFObject {
  const contents = obj.get("Contents");
  if (contents.isArray()) {
    const copy = pdf.newArray();
    for (let i = 0; i < contents.length; i++) copy.push(contents.get(i));
    return copy;
  }
  const list = pdf.newArray();
  if (!contents.isNull()) list.push(contents);
  return list;
}

function readContents(obj: mupdf.PDFObject): string {
  const c = obj.get("Contents");
  const parts: string[] = [];
  if (c.isArray()) for (let i = 0; i < c.length; i++) parts.push(c.get(i).readStream().asString());
  else if (c.isStream()) parts.push(c.readStream().asString());
  return parts.join("\n");
}

function ownResources(pdf: mupdf.PDFDocument, page: mupdf.PDFObject): mupdf.PDFObject {
  const own = page.get("Resources");
  if (own.isDictionary()) return own;
  const res = pdf.newDictionary();
  const inherited = page.getInheritable("Resources");
  if (inherited.isDictionary()) inherited.forEach((v, k) => res.put(k, v));
  const ref = pdf.addObject(res);
  page.put("Resources", ref);
  return ref;
}
