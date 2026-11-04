import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PdfEngine } from "../../src/core/engine";
import { fromXfdf, parseXml } from "../../src/core/xfdf";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
function open(name = "sample.pdf") {
  const engine = new PdfEngine();
  const r = engine.open(fixture(name));
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}
const author = "Tester";

describe("XFDF", () => {
  it("round-trips comments, geometry and replies between documents", () => {
    const a = open();
    const note = a.engine.createAnnotation(a.docId, 0, { author, type: "Text", point: [100, 100], contents: "Hello & <welcome>" });
    a.engine.replyToAnnotation(a.docId, 0, note.id!, "A reply\non two lines", "Bob");
    a.engine.createAnnotation(a.docId, 1, { author, type: "Highlight", quads: [[72, 46, 300, 46, 72, 80, 300, 80]], color: [1, 0.8, 0] });
    a.engine.createAnnotation(a.docId, 1, { author, type: "Ink", strokes: [[[100, 700], [120, 720], [140, 700]]], color: [0, 0.5, 0], borderWidth: 3 });
    a.engine.createAnnotation(a.docId, 2, { author, type: "Line", line: [[72, 650], [300, 650]], endings: ["None", "ClosedArrow"], intent: "LineArrow" });
    a.engine.createAnnotation(a.docId, 2, { author, type: "FreeText", rect: [72, 500, 300, 540], fontSize: 14, contents: "Typed", color: [0.7, 0.1, 0.1] });
    a.engine.createAnnotation(a.docId, 3, { author, type: "Polygon", vertices: [[350, 600], [450, 600], [400, 680]], interiorColor: [1, 1, 0.5] });
    const xml = a.engine.exportXfdf(a.docId, "sample.pdf");
    expect(xml).toContain('<xfdf xmlns="http://ns.adobe.com/xfdf/"');
    expect(xml).toContain("Hello &amp; &lt;welcome&gt;");

    const b = open();
    const res = b.engine.importXfdf(b.docId, xml, "Fallback");
    expect(res).toMatchObject({ imported: 7, skipped: 0 });
    const before = a.engine.annotations(a.docId);
    const after = b.engine.annotations(b.docId);
    expect(after.map((x) => [x.type, x.page])).toEqual(before.map((x) => [x.type, x.page]));
    for (let i = 0; i < before.length; i++) {
      if (!before[i].hidden) for (let k = 0; k < 4; k++) expect(after[i].rect[k]).toBeCloseTo(before[i].rect[k], 0);
      expect(after[i].contents).toBe(before[i].contents);
      expect(after[i].author).toBe(before[i].author);
    }
    const reply = after.find((x) => x.contents.startsWith("A reply"))!;
    expect(reply.inReplyTo).toBe(after.find((x) => x.contents.startsWith("Hello"))!.id);
    expect(after.find((x) => x.type === "FreeText")!.fontSize).toBe(14);
    // Import is one undoable step.
    b.engine.undo(b.docId);
    expect(b.engine.annotations(b.docId)).toHaveLength(0);
  });

  it("reads Acrobat-style XFDF with namespaces, rich text and skipped types", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots>
<square color="#FF0000" creationdate="D:20240101120000Z" flags="print" date="D:20240101120000Z" name="a1" page="0" rect="100,100,200,150" title="Alice" width="2"><contents-richtext><body xmlns="http://www.w3.org/1999/xhtml"><p>Rich <span>text</span></p></body></contents-richtext></square>
<sound page="0" rect="0,0,10,10" name="s1"/>
<text page="9" rect="0,0,10,10" name="far"/>
</annots><f href="x.pdf"/></xfdf>`;
    const items = fromXfdf(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ element: "square", title: "Alice", contents: "Rich text", width: 2, color: "#FF0000" });
    const t = open();
    expect(t.engine.importXfdf(t.docId, xml, "x")).toMatchObject({ imported: 1, skipped: 1 });
  });

  it("rejects files that aren't XFDF and XML with entity declarations", () => {
    expect(() => fromXfdf("<html></html>")).toThrow(/isn't an XFDF/);
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>')).toThrow(/DOCTYPE/);
    expect(() => parseXml("<a><b></a>")).toThrow();
  });
});
