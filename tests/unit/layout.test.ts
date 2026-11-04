import { describe, expect, it } from "vitest";
import { rectToView, rotate, toPage, toView } from "../../src/ui/geometry";
import { layoutPages, pagesInRange, rowAt, rowsFor } from "../../src/ui/layout";

const letter = { width: 612, height: 792 };

describe("rows", () => {
  it("groups pages per layout mode", () => {
    expect(rowsFor(5, "single")).toEqual([[0], [1], [2], [3], [4]]);
    expect(rowsFor(5, "two-page")).toEqual([[0, 1], [2, 3], [4]]);
    expect(rowsFor(5, "two-page-cover")).toEqual([[0], [1, 2], [3, 4]]);
  });
});

describe("layoutPages", () => {
  it("stacks single pages centred with gaps", () => {
    const l = layoutPages([letter, letter], 0, "single", 1, 1000);
    expect(l.boxes[0]).toEqual({ x: (1000 - 612) / 2, y: 24, w: 612, h: 792 });
    expect(l.boxes[1].y).toBe(24 + 792 + 16);
    expect(l.height).toBe(24 + 792 * 2 + 16 + 24);
  });

  it("places spreads side by side and swaps sizes when rotated", () => {
    const l = layoutPages([letter, letter, letter], 90, "two-page", 1, 400);
    expect(l.boxes[0].w).toBe(792);
    expect(l.boxes[1].x).toBe(l.boxes[0].x + 792 + 16);
    expect(l.boxes[1].y).toBe(l.boxes[0].y);
    expect(l.width).toBe(792 * 2 + 16 + 48);
  });

  it("finds rows and visible pages from a scroll position", () => {
    const l = layoutPages(Array(10).fill(letter), 0, "single", 0.5, 800);
    expect(rowAt(l, 0)).toBe(0);
    expect(rowAt(l, 24 + 412 * 3 + 5)).toBe(3);
    expect(pagesInRange(l, 24 + 412 * 3, 24 + 412 * 4)).toEqual([3, 4]);
  });
});

describe("geometry", () => {
  it("round-trips points through every rotation", () => {
    for (const r of [0, 90, 180, 270] as const) {
      const v = toView([100, 50], letter, r);
      expect(toPage(v, letter, r)).toEqual([100, 50]);
    }
  });

  it("maps the top-left corner as MuPDF renders it", () => {
    expect(toView([0, 0], letter, 90)).toEqual([792, 0]); // top-left goes to top-right
    expect(rectToView([0, 0, 10, 20], letter, 0, 2)).toEqual([0, 0, 20, 40]);
  });

  it("rotates in quarter turns", () => {
    expect(rotate(0, -90)).toBe(270);
    expect(rotate(270, 90)).toBe(0);
  });
});
