import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PdfEngine } from "../../src/core/engine";
import { RESULT_HEADER_H, RESULT_ITEM_H, hitAt, resultLayout } from "../../src/ui/doc/SearchResults";
import type { SearchHit } from "../../src/core/types";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const hit = (page: number, start = 0): SearchHit => ({ page, start, end: start + 1, rects: [] });

describe("search results list layout", () => {
  it("places each row after its page heading, and finds the row at a height", () => {
    const hits = [hit(0), hit(0, 5), hit(2), hit(7), hit(7, 3)];
    const { headers, height } = resultLayout(hits);
    expect([...headers]).toEqual([1, 1, 2, 3, 3]);
    expect(height).toBe(5 * RESULT_ITEM_H + 3 * RESULT_HEADER_H);
    // Row 2 (page 3) starts after two headings and two rows.
    const top2 = 2 * RESULT_ITEM_H + 2 * RESULT_HEADER_H;
    expect(hitAt(headers, 0)).toBe(0);
    expect(hitAt(headers, top2 - 1)).toBe(2);
    expect(hitAt(headers, top2 + RESULT_ITEM_H)).toBe(3);
    expect(hitAt(headers, height + 1000)).toBe(5);
  });

  it("lays out a million hits quickly", () => {
    const hits = Array.from({ length: 1_000_000 }, (_, i) => hit(i >> 6, i & 63));
    const t = performance.now();
    const { headers } = resultLayout(hits);
    expect(hitAt(headers, 1e9)).toBe(1_000_000);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("hits without snippets", () => {
  it("finds well over 5,000 hits, and fetches the same snippets later", () => {
    const engine = new PdfEngine();
    const r = engine.open(fixture("long-600.pdf"));
    if (r.status !== "ok") throw new Error("expected ok");
    const id = r.info.docId;
    const opts = { caseSensitive: false, wholeWord: false, regex: true };
    const all: SearchHit[] = [];
    for (let p = 0; p < 600; ) {
      const { hits, next } = engine.find(id, "[a-z]", opts, p, 600, 1_000_000, 10_000, true, false);
      for (const h of hits) all.push(h);
      p = next;
    }
    expect(all.length).toBeGreaterThan(5000);
    expect(all[0].match).toBeUndefined();
    // Every hit shares one empty rectangle list instead of carrying its own.
    expect(new Set(all.map((h) => h.rects)).size).toBe(1);
    const sample = [all[0], all[2500], all[all.length - 1]];
    const withText = sample.map((h) => engine.find(id, "[a-z]", opts, h.page, h.page + 1).hits.find((x) => x.start === h.start)!);
    const snippets = engine.hitSnippets(id, sample);
    snippets.forEach((s, i) => expect(s).toEqual({ before: withText[i].before, match: withText[i].match, after: withText[i].after }));
  });
});

describe("search batches", () => {
  it("never drops hits on the page where a batch fills up", () => {
    const engine = new PdfEngine();
    const r = engine.open(fixture("long-300.pdf"));
    if (r.status !== "ok") throw new Error("expected ok");
    const opts = { caseSensitive: false, wholeWord: false, regex: true };
    const whole = engine.find(r.info.docId, "[a-z]", opts, 0, 300, Infinity, 1e6, true, false).hits;
    // Tiny batches, each ending mid-page: together they must find exactly the same hits.
    const batched = [];
    for (let p = 0; p < 300; ) {
      const { hits, next } = engine.find(r.info.docId, "[a-z]", opts, p, 300, 7, 1e6, true, false);
      batched.push(...hits);
      expect(next).toBeGreaterThan(p);
      p = next;
    }
    expect(batched.map((h) => `${h.page}:${h.start}`)).toEqual(whole.map((h) => `${h.page}:${h.start}`));
  });
});
