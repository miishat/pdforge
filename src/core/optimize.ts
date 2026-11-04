// Making files smaller: downsampling and recompressing images, subsetting fonts, and dropping
// unused objects. The image work happens on the document (as one undoable step); the object
// clean-up happens when the file is written with the options returned by `saveOptionsFor`.
import * as mupdf from "mupdf";

export type CompressPreset = "screen" | "ebook" | "print" | "custom";

export interface CompressOptions {
  /** Images shown at more than this resolution are scaled down to it. 0 = keep resolution. */
  imageDpi: number;
  /** JPEG quality, 1–100, for recompressed colour and grey images. */
  jpegQuality: number;
  /** Re-encode images even when they don't need downsampling (kept only if smaller). */
  recompress: boolean;
  subsetFonts: boolean;
  /** Merge duplicate objects and drop unreferenced ones. */
  removeUnused: boolean;
  /** Pack small objects into compressed object streams. */
  objectStreams: boolean;
}

export const PRESETS: Record<Exclude<CompressPreset, "custom">, CompressOptions & { label: string; hint: string }> = {
  screen: { label: "Screen", hint: "Smallest file; 72 dpi images, good for email", imageDpi: 72, jpegQuality: 50, recompress: true, subsetFonts: true, removeUnused: true, objectStreams: true },
  ebook: { label: "E-book", hint: "Balanced; 150 dpi images, sharp on any screen", imageDpi: 150, jpegQuality: 72, recompress: true, subsetFonts: true, removeUnused: true, objectStreams: true },
  print: { label: "Print", hint: "High quality; 300 dpi images, for printing", imageDpi: 300, jpegQuality: 88, recompress: false, subsetFonts: true, removeUnused: true, objectStreams: true },
};

export interface CompressReport {
  imagesResampled: number;
  imagesRecompressed: number;
  imagesKept: number;
  fontsSubset: boolean;
}

interface ImageObject {
  num: number;
  obj: mupdf.PDFObject;
  image: mupdf.Image;
  /** Smallest effective resolution the image is drawn at (largest on-page size). */
  dpi: number;
  /** True when the image is used as a mask, or in a way we can't measure (patterns, Type 3 glyphs). */
  skip: boolean;
}

/** Downsamples and recompresses images in place. */
export function compressImages(pdf: mupdf.PDFDocument, opts: CompressOptions): CompressReport {
  const report: CompressReport = { imagesResampled: 0, imagesRecompressed: 0, imagesKept: 0, fontsSubset: false };
  const images = collectImages(pdf);
  for (const im of images.values()) {
    if (im.skip || !Number.isFinite(im.dpi)) {
      report.imagesKept++;
      continue;
    }
    const outcome = rewriteImage(pdf, im, opts);
    if (outcome === "resampled") report.imagesResampled++;
    else if (outcome === "recompressed") report.imagesRecompressed++;
    else report.imagesKept++;
  }
  if (opts.subsetFonts) {
    try {
      pdf.subsetFonts();
      report.fontsSubset = true;
    } catch {
      // Some font types can't be subset; the rest of the work still counts.
    }
  }
  return report;
}

/** MuPDF options for a full save after compressing. */
export function saveOptionsFor(opts: CompressOptions): string {
  const parts = [opts.removeUnused ? "garbage=deduplicate" : "garbage=compact", "compress", "compress-fonts", "compress-images"];
  if (opts.objectStreams) parts.push("objstms");
  return parts.join(",");
}

function collectImages(pdf: mupdf.PDFDocument): Map<number, ImageObject> {
  const byNum = new Map<number, ImageObject>();
  const byPointer = new Map<number, ImageObject>();
  const masks = new Set<number>();
  const n = pdf.countObjects();
  for (let i = 1; i < n; i++) {
    const obj = pdf.newIndirect(i);
    if (!obj.isStream()) continue;
    const r = obj.resolve();
    const subtype = r.get("Subtype");
    if (!subtype.isName() || subtype.asName() !== "Image") continue;
    for (const key of ["SMask", "Mask"]) {
      const m = r.get(key);
      if (m.isIndirect()) masks.add(m.asIndirect());
    }
    let image: mupdf.Image;
    try {
      image = pdf.loadImage(obj);
    } catch {
      continue;
    }
    // Images stay loaded during the pass, so MuPDF's cache hands back the same object when drawing.
    const entry: ImageObject = { num: i, obj, image, dpi: Infinity, skip: r.get("ImageMask").isBoolean() && r.get("ImageMask").asBoolean() };
    byNum.set(i, entry);
    byPointer.set(image.pointer, entry);
  }
  for (const num of masks) {
    const e = byNum.get(num);
    if (e) e.skip = true;
  }
  if (byNum.size === 0) return byNum;

  const measure = (image: mupdf.Image, ctm: mupdf.Matrix) => {
    const e = byPointer.get(image.pointer);
    if (!e) return;
    // The unit square maps to the drawn image; its side lengths are the on-page size in points.
    const w = Math.hypot(ctm[0], ctm[1]);
    const h = Math.hypot(ctm[2], ctm[3]);
    if (w < 0.01 || h < 0.01) return;
    const dpi = Math.min((image.getWidth() / w) * 72, (image.getHeight() / h) * 72);
    e.dpi = Math.min(e.dpi, dpi);
  };
  const device = new mupdf.Device({
    fillImage: (image: mupdf.Image, ctm: mupdf.Matrix) => measure(image, ctm),
    fillImageMask: (image: mupdf.Image, ctm: mupdf.Matrix) => measure(image, ctm),
    clipImageMask: (image: mupdf.Image, ctm: mupdf.Matrix) => measure(image, ctm),
  } as unknown as ConstructorParameters<typeof mupdf.Device>[0]);
  for (let p = 0; p < pdf.countPages(); p++) {
    const page = pdf.loadPage(p);
    try {
      page.run(device, mupdf.Matrix.identity);
    } catch {
      // A broken page shouldn't stop the others from being measured.
    }
    page.destroy();
  }
  device.close();
  return byNum;
}

type Outcome = "resampled" | "recompressed" | "kept";

function rewriteImage(pdf: mupdf.PDFDocument, im: ImageObject, opts: CompressOptions): Outcome {
  // Stream operations need the indirect reference (the resolved dictionary isn't a stream).
  const dict = im.obj;
  const bpc = im.image.getBitsPerComponent();
  const w = im.image.getWidth();
  const h = im.image.getHeight();
  // 1-bit scans (CCITT, JBIG2) are already compact and JPEG would ruin them; tiny images aren't worth it.
  if (bpc < 8 || w * h < 64 * 64) return "kept";
  const filter = filterName(dict);
  if (filter === "JBIG2Decode" || filter === "CCITTFaxDecode" || filter === "JPXDecode") return "kept";

  const factor = opts.imageDpi > 0 && im.dpi > opts.imageDpi * 1.15 ? opts.imageDpi / im.dpi : 1;
  if (factor === 1 && !opts.recompress) return "kept";

  let pix: mupdf.Pixmap;
  try {
    pix = im.image.toPixmap();
  } catch {
    return "kept";
  }
  const cs = pix.getColorSpace();
  let target: mupdf.Pixmap | null = null;
  try {
    const gray = cs?.isGray() ?? false;
    const rgb = gray ? pix : pix.convertToColorSpace(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false);
    target = factor < 1 ? downscale(rgb, Math.max(1, Math.round(w * factor)), Math.max(1, Math.round(h * factor)), gray) : rgb;
    const jpeg = target.asJPEG(clampQuality(opts.jpegQuality));
    const oldSize = safeLength(dict);
    // Keep the original unless the new one is clearly smaller (or it had to shrink anyway).
    if (factor === 1 && jpeg.length >= oldSize * 0.95) return "kept";
    if (factor < 1 && jpeg.length >= oldSize) return "kept";
    dict.writeRawStream(jpeg);
    dict.put("Filter", pdf.newName("DCTDecode"));
    dict.put("Width", target.getWidth());
    dict.put("Height", target.getHeight());
    dict.put("BitsPerComponent", 8);
    dict.put("ColorSpace", pdf.newName(gray ? "DeviceGray" : "DeviceRGB"));
    for (const key of ["DecodeParms", "Decode", "Intent"]) dict.delete(key);
    return factor < 1 ? "resampled" : "recompressed";
  } catch {
    return "kept";
  }
}

/** Area-average downscaling, which keeps detail better than point sampling. */
export function downscale(src: mupdf.Pixmap, dw: number, dh: number, gray: boolean): mupdf.Pixmap {
  const sw = src.getWidth();
  const sh = src.getHeight();
  const n = src.getNumberOfComponents() + (src.getAlpha() ? 1 : 0);
  const stride = src.getStride();
  const pixels = src.getPixels();
  const out = new mupdf.Pixmap(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [0, 0, dw, dh], false);
  const outN = gray ? 1 : 3;
  const dst = out.getPixels();
  const dstStride = out.getStride();
  const sums = new Float64Array(dw * outN);
  const xs = new Float64Array(dw + 1);
  for (let x = 0; x <= dw; x++) xs[x] = (x * sw) / dw;
  for (let y = 0; y < dh; y++) {
    sums.fill(0);
    const y0 = (y * sh) / dh;
    const y1 = ((y + 1) * sh) / dh;
    let area = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
      const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
      area += wy;
      const row = sy * stride;
      for (let x = 0; x < dw; x++) {
        const x0 = xs[x];
        const x1 = xs[x + 1];
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wgt = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const i = row + sx * n;
          for (let c = 0; c < outN; c++) sums[x * outN + c] += pixels[i + c] * wgt;
        }
      }
    }
    const xArea = sw / dw;
    for (let x = 0; x < dw; x++) {
      for (let c = 0; c < outN; c++) dst[y * dstStride + x * outN + c] = sums[x * outN + c] / (area * xArea);
    }
  }
  return out;
}

function filterName(dict: mupdf.PDFObject): string {
  const f = dict.get("Filter");
  if (f.isName()) return f.asName();
  if (f.isArray() && f.length > 0) return f.get(f.length - 1).asName();
  return "";
}

function safeLength(dict: mupdf.PDFObject): number {
  try {
    return dict.readRawStream().getLength();
  } catch {
    return Infinity;
  }
}

function clampQuality(q: number): number {
  return Math.max(10, Math.min(100, Math.round(q)));
}
