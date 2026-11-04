// Saved handwritten signatures and initials (PNG with transparency), kept on this computer only.
import { load, save } from "../settings";

export interface SavedSignature {
  id: string;
  kind: "signature" | "initials";
  /** data:image/png;base64,… */
  png: string;
  aspect: number;
  createdAt: number;
}

const KEY = "signatures";
const MAX_PER_KIND = 6;

export function loadSignatures(): SavedSignature[] {
  return load<SavedSignature[]>(KEY, []);
}

export function addSignature(list: SavedSignature[], sig: Omit<SavedSignature, "id" | "createdAt">): SavedSignature[] {
  const entry: SavedSignature = { ...sig, id: Math.random().toString(36).slice(2), createdAt: Date.now() };
  const same = list.filter((s) => s.kind === sig.kind);
  const others = list.filter((s) => s.kind !== sig.kind);
  const next = [entry, ...same].slice(0, MAX_PER_KIND).concat(others);
  save(KEY, next);
  return next;
}

export function removeSignature(list: SavedSignature[], id: string): SavedSignature[] {
  const next = list.filter((s) => s.id !== id);
  save(KEY, next);
  return next;
}

export function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Crops transparent margins; returns null for an empty canvas. */
export function trimCanvas(src: HTMLCanvasElement, pad = 4): HTMLCanvasElement | null {
  const ctx = src.getContext("2d")!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Makes near-white pixels transparent (for photographed or scanned signatures). */
export function removeBackground(c: HTMLCanvasElement, threshold = 225): void {
  const ctx = c.getContext("2d")!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum >= threshold) d[i + 3] = 0;
    else if (lum > threshold - 40) d[i + 3] = Math.round(d[i + 3] * ((threshold - lum) / 40));
  }
  ctx.putImageData(img, 0, 0);
}

/** Handwriting fonts that ship with Windows, best first. */
const CANDIDATE_FONTS = ["Segoe Script", "Ink Free", "Lucida Handwriting", "Segoe Print", "Brush Script MT", "Comic Sans MS"];

/** Whether a font is installed: text measures differently from both generic fallbacks. */
function installed(font: string): boolean {
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return false;
  const sample = "Signature Mmwl 0123";
  return ["monospace", "serif"].some((fallback) => {
    c.font = `40px ${fallback}`;
    const base = c.measureText(sample).width;
    c.font = `40px "${font}", ${fallback}`;
    return c.measureText(sample).width !== base;
  });
}

let cached: string[] | null = null;
/** The installed handwriting fonts; falls back to the generic "cursive" family when none are. */
export function scriptFonts(): string[] {
  if (cached) return cached;
  const found = CANDIDATE_FONTS.filter(installed);
  cached = found.length ? found : ["cursive"];
  return cached;
}
