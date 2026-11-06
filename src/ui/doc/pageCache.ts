// Rendered page bitmaps kept per document, so pages scrolled back to (or drawn ahead of time) appear at once,
// and small previews that stand in for a page while its sharp bitmap is still being drawn.
import type { ViewRotation } from "../../core/types";

/** Sharp bitmaps kept, in bytes (about 20 full-screen pages). */
export const SHARP_BUDGET = 128 * 1024 * 1024;
/** Previews kept, in bytes (about 130 letter-size pages). */
export const PREVIEW_BUDGET = 64 * 1024 * 1024;
/** A preview's longer side, in device pixels: enough to show the page's layout while the sharp one is drawn. */
export const PREVIEW_PIXELS = 400;

/** The smallest part of a bitmap that matters here; satisfied by ImageBitmap. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** Least-recently-used bitmaps under a byte budget. Evicted bitmaps are closed (their pixels freed at once). */
export class BitmapLru<B extends Bitmap = ImageBitmap> {
  private items = new Map<string, B>();
  bytes = 0;

  constructor(readonly budget: number) {}

  get(key: string): B | undefined {
    const b = this.items.get(key);
    if (b) {
      this.items.delete(key);
      this.items.set(key, b);
    }
    return b;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** Stores a bitmap (the cache owns it from now on: don't close it). Too large for the budget: closed, not kept. */
  put(key: string, bitmap: B): void {
    const old = this.items.get(key);
    if (old === bitmap) return;
    if (old) this.drop(key, old);
    const size = bitmap.width * bitmap.height * 4;
    if (size > this.budget) {
      bitmap.close();
      return;
    }
    this.items.set(key, bitmap);
    this.bytes += size;
    for (const [k, b] of this.items) {
      if (this.bytes <= this.budget) break;
      this.drop(k, b);
    }
  }

  /** Forgets every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const [k, b] of [...this.items]) if (k.startsWith(prefix)) this.drop(k, b);
  }

  clear(): void {
    for (const [k, b] of [...this.items]) this.drop(k, b);
  }

  get size(): number {
    return this.items.size;
  }

  private drop(key: string, b: B) {
    this.items.delete(key);
    this.bytes -= b.width * b.height * 4;
    b.close();
  }
}

/** Device-pixel scale of a page's preview. */
export function previewScale(width: number, height: number): number {
  return PREVIEW_PIXELS / Math.max(width, height, 1);
}

export class PageBitmaps<B extends Bitmap = ImageBitmap> {
  readonly sharp = new BitmapLru<B>(SHARP_BUDGET);
  readonly previews = new BitmapLru<B>(PREVIEW_BUDGET);

  sharpKey(page: number, scale: number, rotation: ViewRotation, version: number): string {
    return `${page}|${version}|${rotation}|${scale.toFixed(4)}`;
  }

  previewKey(page: number, rotation: ViewRotation, version: number): string {
    return `${page}|${version}|${rotation}`;
  }

  /** Forgets a page's bitmaps when its content changes (older versions would never be asked for again). */
  forgetPage(page: number): void {
    this.sharp.deletePrefix(`${page}|`);
    this.previews.deletePrefix(`${page}|`);
  }

  clear(): void {
    this.sharp.clear();
    this.previews.clear();
  }
}
