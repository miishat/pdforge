import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../../src/core/engine";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

function openSample(name = "sample.pdf") {
  const engine = new PdfEngine();
  const r = engine.open(fixture(name));
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}

const author = "Tester";

describe("annotation editing", () => {
  it("creates every supported kind and lists it with its properties", () => {
    const { engine, docId } = openSample();
    const specs = [
      { type: "Highlight", quads: [[72, 46, 300, 46, 72, 80, 300, 80]], color: [1, 0.8, 0] },
      { type: "Underline", quads: [[72, 90, 200, 90, 72, 104, 200, 104]] },
      { type: "StrikeOut", quads: [[72, 110, 200, 110, 72, 124, 200, 124]] },
      { type: "Squiggly", quads: [[72, 130, 200, 130, 72, 144, 200, 144]] },
      { type: "Text", point: [500, 60], contents: "A note" },
      { type: "FreeText", rect: [72, 500, 300, 540], fontSize: 14, contents: "Typed", color: [0.7, 0.1, 0.1] },
      { type: "FreeText", rect: [350, 500, 550, 540], fontSize: 12, contents: "Callout", callout: [[300, 600], [350, 520]] },
      { type: "Square", rect: [72, 560, 172, 620], color: [0, 0, 1], borderWidth: 2 },
      { type: "Circle", rect: [200, 560, 300, 620], interiorColor: [1, 1, 0.6] },
      { type: "Line", line: [[72, 650], [300, 650]], endings: ["None", "ClosedArrow"], intent: "LineArrow" },
      { type: "Line", line: [[72, 680], [216, 680]], intent: "LineDimension", caption: true, contents: "2.00 in", measure: { ratio: 1, unit: "in" } },
      { type: "Polygon", vertices: [[350, 600], [450, 600], [400, 680]], intent: "PolygonDimension" },
      { type: "Ink", strokes: [[[100, 700], [120, 720], [140, 700]]], borderWidth: 2 },
      { type: "Stamp", rect: [350, 300, 550, 360], icon: "Approved" },
    ] as const;
    for (const s of specs) engine.createAnnotation(docId, 0, { author, ...(s as object) } as never);
    const list = engine.annotations(docId, [0]);
    expect(list.map((a) => a.type)).toEqual(specs.map((s) => s.type));
    const note = list.find((a) => a.type === "Text")!;
    expect(note).toMatchObject({ contents: "A note", author, hidden: false });
    const ft = list.find((a) => a.contents === "Typed")!;
    expect(ft.fontSize).toBe(14);
    expect(ft.intent).toBe("FreeTextTypeWriter");
    expect(list.find((a) => a.contents === "Callout")!.intent).toBe("FreeTextCallout");
    expect(list.find((a) => a.type === "Square")!.color).toEqual([0, 0, 1]);
    expect(list.find((a) => a.intent === "LineArrow")!.lineEndings).toEqual(["None", "ClosedArrow"]);
    expect(list.find((a) => a.type === "Stamp")!.resizable).toBe(true);
  });

  it("moves, resizes and restyles annotations", () => {
    const { engine, docId } = openSample();
    const { id } = engine.createAnnotation(docId, 0, { author, type: "Square", rect: [100, 100, 200, 150] });
    engine.updateAnnotation(docId, 0, id!, { translate: [50, 20] });
    let a = engine.annotations(docId, [0])[0];
    // Bounds include half the border width.
    expect(a.rect[0]).toBeGreaterThan(148);
    expect(a.rect[0]).toBeLessThan(151);
    engine.updateAnnotation(docId, 0, id!, { rect: [10, 10, 60, 60], color: [1, 0, 0], opacity: 0.5 });
    a = engine.annotations(docId, [0])[0];
    expect(a.color).toEqual([1, 0, 0]);
    expect(a.opacity).toBeCloseTo(0.5);
    expect(a.rect[2] - a.rect[0]).toBeLessThan(60);

    const ink = engine.createAnnotation(docId, 0, { author, type: "Ink", strokes: [[[300, 300], [320, 340]]] });
    const before = engine.annotations(docId, [0]).find((x) => x.id === ink.id)!.rect;
    engine.updateAnnotation(docId, 0, ink.id!, { translate: [10, -10] });
    const after = engine.annotations(docId, [0]).find((x) => x.id === ink.id)!.rect;
    expect(after[0] - before[0]).toBeCloseTo(10, 0);
    expect(after[1] - before[1]).toBeCloseTo(-10, 0);
  });

  it("threads replies and review status, and deletes a thread together", () => {
    const { engine, docId } = openSample();
    const { id } = engine.createAnnotation(docId, 1, { author, type: "Text", point: [100, 100], contents: "Question?" });
    engine.replyToAnnotation(docId, 1, id!, "Answer.", "Someone");
    engine.replyToAnnotation(docId, 1, id!, "Accepted set by Someone", "Someone", "Accepted");
    const list = engine.annotations(docId, [1]);
    expect(list).toHaveLength(3);
    const replies = list.filter((a) => a.inReplyTo === id);
    expect(replies.map((r) => r.contents)).toEqual(["Answer.", "Accepted set by Someone"]);
    expect(replies.every((r) => r.hidden)).toBe(true);
    expect(replies[1].state).toBe("Accepted");
    engine.deleteAnnotation(docId, 1, id!);
    expect(engine.annotations(docId, [1])).toHaveLength(0);
  });

  it("undoes and redoes changes and tracks unsaved state", () => {
    const { engine, docId } = openSample();
    expect(engine.editState(docId)).toMatchObject({ canUndo: false, dirty: false });
    engine.createAnnotation(docId, 0, { author, type: "Text", point: [10, 10] });
    expect(engine.editState(docId)).toMatchObject({ canUndo: true, dirty: true, undoLabel: "Add note" });
    engine.undo(docId);
    expect(engine.annotations(docId, [0])).toHaveLength(0);
    expect(engine.editState(docId)).toMatchObject({ canUndo: false, canRedo: true, dirty: false, redoLabel: "Add note" });
    engine.redo(docId);
    expect(engine.annotations(docId, [0])).toHaveLength(1);
    engine.save(docId);
    expect(engine.editState(docId).dirty).toBe(false);
    engine.undo(docId);
    expect(engine.editState(docId).dirty).toBe(true);
  });

  it("saves incrementally by default, keeping the original bytes intact", () => {
    const { engine, docId } = openSample();
    const original = fixture("sample.pdf");
    engine.createAnnotation(docId, 0, { author, type: "Square", rect: [10, 10, 50, 50] });
    const inc = engine.save(docId);
    expect(Buffer.from(inc.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    const reopened = mupdf.Document.openDocument(inc, "application/pdf").asPDF()!;
    expect((reopened.loadPage(0) as mupdf.PDFPage).getAnnotations()).toHaveLength(1);
    const full = engine.save(docId, { incremental: false });
    expect((mupdf.Document.openDocument(full, "application/pdf").asPDF()!.loadPage(0) as mupdf.PDFPage).getAnnotations()).toHaveLength(1);
  });

  it("explains failures without leaving a half-finished step", () => {
    const { engine, docId } = openSample();
    expect(() => engine.updateAnnotation(docId, 0, 9999, { contents: "x" })).toThrow(/no longer exists/);
    expect(engine.editState(docId).canUndo).toBe(false);
  });
});
