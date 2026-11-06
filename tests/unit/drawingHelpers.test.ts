import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PdfEngine, rgbBytesToRgba } from "../../src/core/engine";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

function naive(rgb: Uint8Array, width: number, height: number, stride: number) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const s = y * stride + x * 3;
      const d = (y * width + x) * 4;
      out.set([rgb[s], rgb[s + 1], rgb[s + 2], 255], d);
    }
  return out;
}

describe("RGB to RGBA", () => {
  it("matches a plain per-byte copy for every width, padding and alignment", () => {
    for (const offset of [0, 1, 4])
      for (let width = 1; width <= 9; width++)
        for (const pad of [0, 1, 2]) {
          const height = 3;
          const stride = width * 3 + pad;
          const buf = new Uint8Array(offset + stride * height);
          for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + 11) & 255;
          const rgb = buf.subarray(offset);
          expect(rgbBytesToRgba(rgb, width, height, stride)).toEqual(naive(rgb, width, height, stride));
        }
  });
});

describe("drawing copies", () => {
  it("offers a copy only while what's open is exactly the file", () => {
    const engine = new PdfEngine();
    const r = engine.open(fixture("sample.pdf"));
    if (r.status !== "ok") throw new Error("expected ok");
    const id = r.info.docId;
    const first = engine.drawingSource(id, null);
    expect(first.shareable).toBe(true);
    if (!first.shareable) return;
    expect(first.bytes?.length).toBeGreaterThan(0);
    // The helpers already hold this version: no second copy.
    expect(engine.drawingSource(id, first.stamp)).toEqual({ shareable: true, stamp: first.stamp });
    engine.rotatePages(id, [0], 90);
    expect(engine.drawingSource(id, first.stamp)).toEqual({ shareable: false });
    engine.undo(id);
    expect(engine.drawingSource(id, first.stamp)).toEqual({ shareable: true, stamp: first.stamp });
    // After a save, the new file is a new version.
    engine.rotatePages(id, [0], 90);
    const saved = engine.save(id, { markSaved: false });
    engine.setFileBytes(id, saved);
    engine.save(id, { markSaved: true });
    const after = engine.drawingSource(id, first.stamp);
    expect(after.shareable && after.stamp !== first.stamp && after.bytes?.length).toBeTruthy();
  });

  it("never offers password-protected files", () => {
    const engine = new PdfEngine();
    const r = engine.open(fixture("encrypted.pdf"));
    const id = r.status === "ok" ? r.info.docId : r.docId;
    expect(engine.drawingSource(id, null)).toEqual({ shareable: false });
  });

  it("a copy opened for drawing draws the same pixels as the open document", () => {
    const main = new PdfEngine();
    const r = main.open(fixture("features.pdf"));
    if (r.status !== "ok") throw new Error("expected ok");
    const src = main.drawingSource(r.info.docId, null);
    if (!src.shareable || !src.bytes) throw new Error("expected a copy");
    const helper = new PdfEngine();
    const hid = helper.openForDrawing(src.bytes);
    for (let p = 0; p < r.info.pageCount; p++) {
      const a = main.render({ docId: r.info.docId, pageIndex: p, scale: 0.75, rotation: 90 });
      const b = helper.render({ docId: hid, pageIndex: p, scale: 0.75, rotation: 90 });
      expect(b.width).toBe(a.width);
      expect(Buffer.from(b.pixels).equals(Buffer.from(a.pixels))).toBe(true);
    }
  });
});

/**
 * The client with in-process engines standing in for the workers, so the scheduling and the checks that keep helpers
 * from drawing a changed document can be exercised without a browser.
 */
class FakeWorker {
  static all: FakeWorker[] = [];
  engine = new PdfEngine();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  renders = 0;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; op: string; args: unknown[] }) {
    setTimeout(() => {
      let reply;
      try {
        const fn = (this.engine as unknown as Record<string, (...a: unknown[]) => unknown>)[msg.op];
        let value = fn.apply(this.engine, msg.args);
        if (msg.op === "render") {
          this.renders++;
          const page = value as { width: number; height: number; pixels: Uint8ClampedArray };
          value = { bitmap: { width: page.width, height: page.height, pixels: page.pixels, close() {} }, width: page.width, height: page.height };
        }
        reply = { id: msg.id, ok: true, value };
      } catch (err) {
        reply = { id: msg.id, ok: false, message: String(err) };
      }
      this.onmessage?.({ data: reply });
    }, 1);
  }
  terminate() {}
}

describe("render scheduling with drawing helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.all = [];
  });

  async function setup(cores: number) {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("navigator", { hardwareConcurrency: cores });
    const { EngineClient } = await import("../../src/core/client");
    const client = new EngineClient();
    const r = await client.call("open", fixture("sample.pdf"));
    if (r.status !== "ok") throw new Error("expected ok");
    return { client, docId: r.info.docId };
  }

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it("spreads pages over the main engine and two helpers, and stops using the helpers after a change", async () => {
    const { client, docId } = await setup(8);
    client.shareForDrawing(docId);
    await until(() => client.sharedForDrawing(docId));
    const [main, h1, h2] = FakeWorker.all;
    expect(FakeWorker.all.length).toBe(3);
    await until(() => [h1, h2].every((h) => h.engine["docs"].size === 1));
    await new Promise((r) => setTimeout(r, 20));

    const pages = [0, 1, 2, 3, 4];
    const drawn = await Promise.all(pages.map((p) => client.render({ docId, pageIndex: p, scale: 0.25, rotation: 0 }, p)));
    expect(drawn.every((d) => d.width > 0)).toBe(true);
    expect(h1.renders + h2.renders).toBeGreaterThan(0);
    expect(main.renders).toBeGreaterThan(0);

    // An edit: from the moment it's sent, only the main engine draws this document.
    const edit = client.call("rotatePages", docId, [0], 90);
    expect(client.sharedForDrawing(docId)).toBe(false);
    const helperRenders = h1.renders + h2.renders;
    const rotated = await client.render({ docId, pageIndex: 0, scale: 0.25, rotation: 0 }, 0);
    await edit;
    expect(rotated.width).toBeGreaterThan(rotated.height); // drawn after the rotation, by the main engine
    await new Promise((r) => setTimeout(r, 150));
    expect(client.sharedForDrawing(docId)).toBe(false);
    await Promise.all(pages.map((p) => client.render({ docId, pageIndex: p, scale: 0.25, rotation: 0 }, p)));
    expect(h1.renders + h2.renders).toBe(helperRenders);

    // Undoing back to the file lets the helpers draw again, from the copy they already hold.
    await client.call("undo", docId);
    await until(() => client.sharedForDrawing(docId));
    await Promise.all(pages.map((p) => client.render({ docId, pageIndex: p, scale: 0.25, rotation: 0 }, p)));
    expect(h1.renders + h2.renders).toBeGreaterThan(helperRenders);

    // Closing the document closes the helpers' copies.
    await client.call("close", docId);
    await until(() => [h1, h2].every((h) => h.engine["docs"].size === 0));
  });

  it("uses no helpers on a two-core computer", async () => {
    const { client, docId } = await setup(2);
    client.shareForDrawing(docId);
    expect(FakeWorker.all.length).toBe(1);
    const d = await client.render({ docId, pageIndex: 0, scale: 0.25, rotation: 0 }, 0);
    expect(d.width).toBeGreaterThan(0);
  });

  it("a helper that fails hands the page back to the main engine", async () => {
    const { client, docId } = await setup(4);
    client.shareForDrawing(docId);
    await until(() => client.sharedForDrawing(docId));
    const [main, ...helpers] = FakeWorker.all;
    await until(() => helpers.every((h) => h.engine["docs"].size === 1));
    for (const h of helpers) h.engine.render = () => { throw new Error("out of memory"); };
    const d = await client.render({ docId, pageIndex: 1, scale: 0.25, rotation: 0 }, 0);
    expect(d.width).toBeGreaterThan(0);
    expect(main.renders).toBe(1);
  });
});
