import { describe, expect, it } from "vitest";
import { BitmapLru, PageBitmaps, previewScale, PREVIEW_PIXELS } from "../../src/ui/doc/pageCache";

class FakeBitmap {
  closed = false;
  constructor(readonly width: number, readonly height: number) {}
  close() {
    this.closed = true;
  }
}

describe("page bitmap cache", () => {
  it("keeps the most recently used bitmaps under its byte budget, closing the ones it drops", () => {
    const lru = new BitmapLru<FakeBitmap>(3 * 100 * 4); // room for three 10×10 bitmaps
    const [a, b, c, d] = [0, 1, 2, 3].map(() => new FakeBitmap(10, 10));
    lru.put("a", a);
    lru.put("b", b);
    lru.put("c", c);
    expect(lru.get("a")).toBe(a); // a is now the most recent
    lru.put("d", d);
    expect(lru.has("b")).toBe(false);
    expect(b.closed).toBe(true);
    expect([lru.has("a"), lru.has("c"), lru.has("d")]).toEqual([true, true, true]);
    expect(lru.bytes).toBe(1200);
  });

  it("replaces an entry, and never keeps a bitmap bigger than the whole budget", () => {
    const lru = new BitmapLru<FakeBitmap>(1000);
    const old = new FakeBitmap(5, 5);
    const fresh = new FakeBitmap(6, 6);
    lru.put("k", old);
    lru.put("k", fresh);
    expect(old.closed).toBe(true);
    expect(lru.bytes).toBe(144);
    const huge = new FakeBitmap(100, 100);
    lru.put("huge", huge);
    expect(lru.has("huge")).toBe(false);
    expect(lru.has("k")).toBe(true);
  });

  it("forgets every bitmap of an edited page, at any zoom, and nothing else", () => {
    const cache = new PageBitmaps<FakeBitmap>();
    cache.sharp.put(cache.sharpKey(1, 1.5, 0, 7), new FakeBitmap(10, 10));
    cache.sharp.put(cache.sharpKey(1, 2, 90, 7), new FakeBitmap(10, 10));
    cache.sharp.put(cache.sharpKey(11, 1.5, 0, 7), new FakeBitmap(10, 10));
    cache.previews.put(cache.previewKey(1, 0, 7), new FakeBitmap(3, 3));
    cache.forgetPage(1);
    expect(cache.sharp.size).toBe(1);
    expect(cache.sharp.has(cache.sharpKey(11, 1.5, 0, 7))).toBe(true);
    expect(cache.previews.size).toBe(0);
  });

  it("sizes previews by their longer side", () => {
    expect(612 * previewScale(612, 792)).toBeLessThan(PREVIEW_PIXELS);
    expect(792 * previewScale(612, 792)).toBeCloseTo(PREVIEW_PIXELS);
    expect(792 * previewScale(792, 612)).toBeCloseTo(PREVIEW_PIXELS);
  });
});
