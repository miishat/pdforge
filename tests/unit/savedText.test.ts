import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PdfEngine } from "../../src/core/engine";
import { packPlainText, sha256Hex, unpackPlainText } from "../../src/core/plainStore";
import { trimSavedText } from "../../src/ui/doc/savedText";
import type { SavedTextEntry, SavedTextStore } from "../../src/platform";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

function open(name: string) {
  const engine = new PdfEngine();
  const r = engine.open(fixture(name));
  if (r.status !== "ok") throw new Error("not opened");
  return { engine, docId: r.info.docId, pages: r.info.pageCount };
}

function readAll(engine: PdfEngine, docId: number, pages: number) {
  for (let p = 0; p < pages; p++) engine.plainText(docId, p);
}

describe("saved search text", () => {
  it("packs and unpacks page text exactly, including empty pages and non-Latin text", async () => {
    const texts = ["", "Hello\nworld", "Ünïcödé — 東京 😀", "x".repeat(3_000_000), ""];
    const packed = await packPlainText(texts);
    expect(packed.length).toBeLessThan(100_000);
    expect(await unpackPlainText(packed)).toEqual(texts);
  });

  it("refuses damaged or foreign data", async () => {
    const packed = await packPlainText(["a", "b"]);
    expect(await unpackPlainText(packed.subarray(0, packed.length - 6))).toBeNull();
    expect(await unpackPlainText(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(await unpackPlainText(await packPlainText([]).then((d) => d))).toEqual([]);
  });

  it("round-trips a document: export once every page is read, import into a fresh copy", async () => {
    const a = open("long-600.pdf");
    expect(a.engine.allPlainText(a.docId)).toBeNull(); // nothing read yet
    readAll(a.engine, a.docId, a.pages);
    const data = await packPlainText(a.engine.allPlainText(a.docId)!);
    expect((await unpackPlainText(data))!).toHaveLength(600);

    const b = open("long-600.pdf");
    expect(await b.engine.textFingerprint(b.docId)).toBe(await a.engine.textFingerprint(a.docId));
    expect(await b.engine.importPlainText(b.docId, data)).toBe("loaded");
    expect(b.engine.firstUnread(b.docId, 0, b.pages)).toBe(b.pages);
    const hits = b.engine.find(b.docId, "quetzal", { caseSensitive: false, wholeWord: false, regex: false }, 0, b.pages, 100, 60_000, false).hits;
    expect(hits.map((h) => h.page)).toEqual([449]);
  });

  it("rejects text from another file, and gives none for a changed document", async () => {
    const other = open("long-300.pdf");
    readAll(other.engine, other.docId, other.pages);
    const wrong = other.engine.allPlainText(other.docId)!;
    const b = open("long-600.pdf");
    expect(await b.engine.importPlainText(b.docId, wrong)).toBe("rejected");
    const shifted = [...b.engine.allPlainText(b.docId) ?? Array.from({ length: 600 }, (_, p) => b.engine.plainText(b.docId, p))];
    shifted[0] = "something else";
    expect(await b.engine.importPlainText(b.docId, shifted)).toBe("rejected");
    expect(await b.engine.textFingerprint(b.docId)).toMatch(/^[0-9a-f]{64}$/);
    b.engine.rotatePages(b.docId, [0], 90);
    expect(await b.engine.textFingerprint(b.docId)).toBeNull();
    expect(b.engine.allPlainText(b.docId)).toBeNull();
    expect(await b.engine.importPlainText(b.docId, shifted)).toBe("changed");
  });

  it("hashes with SHA-256", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("keeps the total under budget by dropping the least recently used, never the one just saved", async () => {
    const rows = new Map<string, SavedTextEntry>([
      ["old", { key: "old", size: 80, used: 1 }],
      ["mid", { key: "mid", size: 80, used: 2 }],
      ["new", { key: "new", size: 80, used: 0 }],
    ]);
    const store: SavedTextStore = {
      read: async () => null,
      write: async () => {},
      list: async () => [...rows.values()],
      remove: async (k) => void rows.delete(k),
      clear: async () => rows.clear(),
    };
    await trimSavedText(store, 200, "new");
    expect([...rows.keys()].sort()).toEqual(["mid", "new"]);
    await trimSavedText(store, 100, "new");
    expect([...rows.keys()]).toEqual(["new"]);
  });
});
