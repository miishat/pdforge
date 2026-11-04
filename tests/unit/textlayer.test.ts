import { describe, expect, it } from "vitest";
import { buildPattern, caretAt, lineAt, searchLayer, wordAt } from "../../src/core/textlayer";
import type { TextLayer } from "../../src/core/types";

/** Builds a fake layer: each line is a row of 10pt-wide chars, 20pt tall, lines 30pt apart. */
function layerOf(lines: string[]): TextLayer {
  const chars: string[] = [];
  const quads: number[] = [];
  const lineIdx: number[] = [];
  lines.forEach((line, li) => {
    if (li > 0) {
      chars.push("\n");
      const x = lines[li - 1].length * 10;
      const y = (li - 1) * 30;
      quads.push(x, y, x, y, x, y + 20, x, y + 20);
      lineIdx.push(li - 1);
    }
    [...line].forEach((c, ci) => {
      chars.push(c);
      const x = ci * 10;
      const y = li * 30;
      quads.push(x, y, x + 10, y, x, y + 20, x + 10, y + 20);
      lineIdx.push(li);
    });
  });
  return { text: chars.join(""), quads: new Float32Array(quads), lines: new Int32Array(lineIdx) };
}

const layer = layerOf(["hello world", "second line"]);

describe("caretAt", () => {
  it("places the caret before the character under the left half", () => {
    expect(caretAt(layer, 2, 10)).toBe(0);
    expect(caretAt(layer, 8, 10)).toBe(1);
  });
  it("snaps to the nearest line and line end", () => {
    expect(caretAt(layer, 500, 5)).toBe(11);
    expect(caretAt(layer, 3, 45)).toBe(12);
  });
  it("returns null for pages without text", () => {
    expect(caretAt({ text: "", quads: new Float32Array(), lines: new Int32Array() }, 0, 0)).toBeNull();
  });
});

describe("word and line ranges", () => {
  it("expands to the word around the caret", () => {
    expect(wordAt(layer, 7)).toEqual([6, 11]);
    expect(wordAt(layer, 11)).toEqual([6, 11]);
  });
  it("expands to the visual line", () => {
    expect(lineAt(layer, 14)).toEqual([12, 23]);
  });
});

describe("search", () => {
  it("matches a phrase across a line break", () => {
    const p = buildPattern("world second", { caseSensitive: false, wholeWord: false, regex: false })!;
    const hits = searchLayer(layer, 0, p);
    expect(hits).toHaveLength(1);
    expect(hits[0].rects).toHaveLength(2);
  });
  it("skips empty regex matches instead of looping forever", () => {
    const p = buildPattern("x*", { caseSensitive: false, wholeWord: false, regex: true })!;
    expect(searchLayer(layer, 0, p)).toEqual([]);
  });
});
