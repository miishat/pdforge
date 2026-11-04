import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PdfEngine } from "../../src/core/engine";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

function openForm() {
  const engine = new PdfEngine();
  const r = engine.open(fixture("form.pdf"));
  if (r.status !== "ok") throw new Error("expected ok");
  return { engine, docId: r.info.docId };
}

describe("forms", () => {
  it("describes every field type with labels, flags and formats", () => {
    const { engine, docId } = openForm();
    const ws = engine.widgets(docId, 0);
    const by = (n: string) => ws.filter((w) => w.name === n);
    expect(ws.map((w) => w.type)).toEqual(["text", "text", "text", "text", "text", "checkbox", "radio", "radio", "combobox", "listbox", "text"]);
    expect(by("name")[0]).toMatchObject({ label: "Full name", required: true, readOnly: false });
    expect(by("total")[0]).toMatchObject({ readOnly: true, calculated: true, format: { kind: "number", currency: "$" } });
    expect(by("date")[0].format).toEqual({ kind: "date", pattern: "mm/dd/yyyy" });
    expect(by("size").map((w) => w.exportValue)).toEqual(["S", "L"]);
    expect(by("colour")[0]).toMatchObject({ value: "Green", options: ["Red", "Green", "Blue"] });
    expect(by("notes")[0].multiline).toBe(true);
    expect(engine.formSummary(docId)).toEqual({ fieldCount: 11, hasXfa: false, unsupportedScripts: 0 });
  });

  it("fills text, recalculates and formats the total", () => {
    const { engine, docId } = openForm();
    const id = (n: string) => engine.widgets(docId, 0).find((w) => w.name === n)!.id;
    engine.setFieldValue(docId, 0, id("qtyA"), "5");
    expect(engine.widgets(docId, 0).find((w) => w.name === "total")!.value).toBe("$8.00");
    engine.setFieldValue(docId, 0, id("qtyB"), "1,250.5");
    expect(engine.widgets(docId, 0).find((w) => w.name === "total")!.value).toBe("$1,255.50");
    engine.setFieldValue(docId, 0, id("date"), "2026-12-25");
    expect(engine.widgets(docId, 0).find((w) => w.name === "date")!.value).toBe("12/25/2026");
    expect(() => engine.setFieldValue(docId, 0, id("total"), "1")).toThrow(/read-only/);
  });

  it("toggles checkboxes and radio groups and sets choices", () => {
    const { engine, docId } = openForm();
    const ws = () => engine.widgets(docId, 0);
    engine.setFieldValue(docId, 0, ws().find((w) => w.name === "subscribe")!.id, "on");
    expect(ws().find((w) => w.name === "subscribe")!.value).not.toBe("Off");
    const [s, l] = ws().filter((w) => w.name === "size");
    engine.setFieldValue(docId, 0, l.id, "L");
    expect(ws().filter((w) => w.name === "size").map((w) => w.value)).toEqual(["L", "L"]);
    engine.setFieldValue(docId, 0, s.id, "S");
    expect(ws().find((w) => w.name === "size")!.value).toBe("S");
    engine.setFieldValue(docId, 0, ws().find((w) => w.name === "delivery")!.id, "Express");
    expect(ws().find((w) => w.name === "delivery")!.value).toBe("Express");
  });

  it("undoes a fill, resets and flattens the form", () => {
    const { engine, docId } = openForm();
    const name = () => engine.widgets(docId, 0).find((w) => w.name === "name")!;
    engine.setFieldValue(docId, 0, name().id, "Ada Lovelace");
    expect(name().value).toBe("Ada Lovelace");
    engine.undo(docId);
    expect(name().value).toBe("");
    engine.setFieldValue(docId, 0, name().id, "Grace");
    engine.resetForm(docId);
    expect(name().value).toBe("");
    engine.setFieldValue(docId, 0, name().id, "Kept");
    engine.flatten(docId, { annotations: true, fields: true });
    expect(engine.widgets(docId, 0)).toHaveLength(0);
    expect(engine.textLayer(docId, 0).text).toContain("Kept");
  });
});
