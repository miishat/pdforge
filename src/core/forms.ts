// Form filling: reading fields, setting values, Acrobat-style formatting and calculations (via the
// safe interpreter in formScripts.ts), reset and flatten.
import * as mupdf from "mupdf";
import { evaluate, formatValue, parseCalculation, parseFormat, type Calculation, type FieldFormat } from "./formScripts";
import type { Rect } from "./types";

export type WidgetType = "text" | "checkbox" | "radio" | "combobox" | "listbox" | "button" | "signature" | "unknown";

export interface WidgetInfo {
  /** Object number of the widget annotation. */
  id: number;
  page: number;
  /** Fully qualified field name; radio buttons in a group share it. */
  name: string;
  /** Tooltip / accessible label (TU), falling back to the name. */
  label: string;
  type: WidgetType;
  rect: Rect;
  value: string;
  options: string[];
  /** The "on" state of a checkbox or radio button. */
  exportValue: string | null;
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  password: boolean;
  maxLen: number;
  comb: boolean;
  /** Combo boxes that also accept typed text. */
  editable: boolean;
  format: FieldFormat | null;
  calculated: boolean;
  /** Font size from the default appearance; 0 means "auto". */
  fontSize: number;
  /** Signature fields: whether a signature is present. */
  signed: boolean;
}

export interface FormSummary {
  fieldCount: number;
  hasXfa: boolean;
  /** Fields with scripts PDForge can't run (anything beyond the standard Acrobat helpers). */
  unsupportedScripts: number;
}

const FF_READONLY = 1 << 0;
const FF_REQUIRED = 1 << 1;
const FF_MULTILINE = 1 << 12;
const FF_PASSWORD = 1 << 13;
const FF_COMBO_EDIT = 1 << 18;
const FF_COMB = 1 << 24;

function js(obj: mupdf.PDFObject, key: string): string | null {
  try {
    const action = obj.get("AA").get(key);
    if (!action.isDictionary()) return null;
    const code = action.get("JS");
    if (code.isString()) return code.asString();
    if (code.isStream()) return code.readStream().asString();
  } catch {
    /* no script */
  }
  return null;
}

/** The field dictionary that carries the value and scripts: the widget itself, or its parent for kids. */
function fieldOf(widgetObj: mupdf.PDFObject): mupdf.PDFObject {
  let f = widgetObj;
  for (let i = 0; i < 10; i++) {
    if (f.get("T").isString() || f.get("FT").isName()) {
      // A widget that is also its own field.
      if (!f.get("Parent").isDictionary() || f.get("T").isString()) return f;
    }
    const parent = f.get("Parent");
    if (!parent.isDictionary()) return f;
    f = parent;
  }
  return f;
}

function typeOf(w: mupdf.PDFWidget): WidgetType {
  const t = safe(() => w.getFieldType(), "");
  if (t === "text") return "text";
  if (t === "checkbox") return "checkbox";
  if (t === "radiobutton") return "radio";
  if (t === "combobox") return "combobox";
  if (t === "listbox") return "listbox";
  if (t === "signature") return "signature";
  if (t === "button") return "button";
  return "unknown";
}

function onState(obj: mupdf.PDFObject): string | null {
  let state: string | null = null;
  safe(() => {
    const n = obj.get("AP").get("N");
    if (n.isDictionary())
      n.forEach((_v, k) => {
        if (k !== "Off") state = String(k);
      });
  }, undefined);
  return state;
}

export function describeWidget(w: mupdf.PDFWidget, page: number): WidgetInfo {
  const obj = w.getObject();
  const field = fieldOf(obj);
  const flags = safe(() => w.getFieldFlags(), 0);
  const type = typeOf(w);
  const tu = safe(() => (field.get("TU").isString() ? field.get("TU").asString() : ""), "");
  const name = safe(() => w.getName(), "");
  const da = safe(() => {
    const d = obj.get("DA").isString() ? obj.get("DA").asString() : field.get("DA").isString() ? field.get("DA").asString() : "";
    const m = /([\d.]+)\s+Tf/.exec(d);
    return m ? Number(m[1]) : 0;
  }, 0);
  return {
    id: obj.asIndirect(),
    page,
    name,
    label: tu || name,
    type,
    rect: safe(() => w.getBounds() as Rect, [0, 0, 0, 0] as Rect),
    value: safe(() => String(w.getValue() ?? ""), ""),
    options: type === "combobox" || type === "listbox" ? safe(() => w.getOptions().map(String), []) : [],
    exportValue: type === "checkbox" || type === "radio" ? onState(obj) : null,
    readOnly: (flags & FF_READONLY) !== 0,
    required: (flags & FF_REQUIRED) !== 0,
    multiline: type === "text" && (flags & FF_MULTILINE) !== 0,
    password: type === "text" && (flags & FF_PASSWORD) !== 0,
    maxLen: type === "text" ? safe(() => w.getMaxLen(), 0) : 0,
    comb: type === "text" && (flags & FF_COMB) !== 0,
    editable: type === "combobox" && (flags & FF_COMBO_EDIT) !== 0,
    format: parseFormat(js(field, "F")),
    calculated: !!js(field, "C"),
    fontSize: da,
    signed: type === "signature" && safe(() => field.get("V").isDictionary(), false),
  };
}

export function pageWidgets(pdf: mupdf.PDFDocument, pageIndex: number): WidgetInfo[] {
  const page = pdf.loadPage(pageIndex);
  try {
    return safe(() => page.getWidgets(), []).map((w) => describeWidget(w, pageIndex));
  } finally {
    page.destroy();
  }
}

export function summarize(pdf: mupdf.PDFDocument): FormSummary {
  const acro = safe(() => pdf.getTrailer().get("Root").get("AcroForm"), null);
  if (!acro || !acro.isDictionary()) return { fieldCount: 0, hasXfa: false, unsupportedScripts: 0 };
  let fieldCount = 0;
  let unsupported = 0;
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    const page = pdf.loadPage(p);
    for (const w of safe(() => page.getWidgets(), [])) {
      fieldCount++;
      const field = fieldOf(w.getObject());
      const calc = js(field, "C");
      const fmt = js(field, "F");
      if ((calc && !parseCalculation(calc)) || (fmt && !parseFormat(fmt))) unsupported++;
    }
    page.destroy();
  }
  return { fieldCount, hasXfa: safe(() => !acro.get("XFA").isNull(), false), unsupportedScripts: unsupported };
}

function findWidget(page: mupdf.PDFPage, id: number): mupdf.PDFWidget {
  const w = page.getWidgets().find((x) => x.getObject().asIndirect() === id);
  if (!w) throw new Error("That form field no longer exists.");
  return w;
}

/**
 * Sets a field's value. Text values are formatted per the field's format script; checkboxes take
 * "on"/"off"; radio buttons take the export value of the button to select. Returns pages changed.
 */
export function setFieldValue(pdf: mupdf.PDFDocument, pageIndex: number, id: number, value: string): number[] {
  const page = pdf.loadPage(pageIndex);
  const w = findWidget(page, id);
  const info = describeWidget(w, pageIndex);
  if (info.readOnly) throw new Error("This field is read-only.");
  switch (info.type) {
    case "text":
      w.setTextValue(formatValue(info.format, value));
      break;
    case "checkbox": {
      const want = value === "on";
      const isOn = info.value !== "" && info.value !== "Off";
      if (want !== isOn) w.toggle();
      break;
    }
    case "radio": {
      // Select the button in the group whose on-state matches; a second click on the selected one keeps it.
      const isOn = info.value === info.exportValue;
      if (!isOn) w.toggle();
      break;
    }
    case "combobox":
    case "listbox":
      w.setChoiceValue(value);
      break;
    default:
      throw new Error("This field can't be filled in.");
  }
  page.update();
  return [pageIndex, ...recalculate(pdf)];
}

/** Runs every calculated field, in the document's calculation order. Returns pages whose fields changed. */
export function recalculate(pdf: mupdf.PDFDocument): number[] {
  const byName = new Map<string, { page: number; w: mupdf.PDFWidget; calc: Calculation | null; fmt: FieldFormat | null }[]>();
  const pages = new Map<number, mupdf.PDFPage>();
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    const page = pdf.loadPage(p);
    const ws = safe(() => page.getWidgets(), []);
    if (!ws.length) continue;
    pages.set(p, page);
    for (const w of ws) {
      const name = safe(() => w.getName(), "");
      const field = fieldOf(w.getObject());
      const entry = { page: p, w, calc: parseCalculation(js(field, "C")), fmt: parseFormat(js(field, "F")) };
      byName.set(name, [...(byName.get(name) ?? []), entry]);
    }
  }
  const order = calculationOrder(pdf, byName);
  const changed = new Set<number>();
  const value = (name: string) => {
    const e = byName.get(name)?.[0];
    return e ? safe(() => String(e.w.getValue() ?? ""), "") : null;
  };
  for (const name of order) {
    const entries = byName.get(name)!;
    const calc = entries[0].calc;
    if (!calc) continue;
    const result = evaluate(calc, value);
    const next = result === null ? "" : formatValue(entries[0].fmt, String(Math.round(result * 1e9) / 1e9));
    for (const e of entries) {
      if (safe(() => String(e.w.getValue() ?? ""), "") !== next) {
        e.w.setTextValue(next);
        changed.add(e.page);
      }
    }
  }
  for (const p of changed) pages.get(p)?.update();
  return [...changed];
}

function calculationOrder(pdf: mupdf.PDFDocument, byName: Map<string, { calc: Calculation | null }[]>): string[] {
  const order: string[] = [];
  safe(() => {
    const co = pdf.getTrailer().get("Root").get("AcroForm").get("CO");
    if (co.isArray())
      for (let i = 0; i < co.length; i++) {
        const f = co.get(i);
        const t = safe(() => fullName(f), "");
        if (t) order.push(t);
      }
  }, undefined);
  // Any calculated field missing from /CO still runs, after the listed ones.
  for (const [name, entries] of byName) if (entries[0].calc && !order.includes(name)) order.push(name);
  return order.filter((n) => byName.has(n));
}

function fullName(f: mupdf.PDFObject): string {
  const parts: string[] = [];
  let cur: mupdf.PDFObject | null = f;
  for (let i = 0; cur && cur.isDictionary() && i < 20; i++) {
    const t = cur.get("T");
    if (t.isString()) parts.unshift(t.asString());
    const parent = cur.get("Parent");
    cur = parent.isDictionary() ? parent : null;
  }
  return parts.join(".");
}

/** Puts every field back to its default value (/DV), or empty/off when there is none. */
export function resetForm(pdf: mupdf.PDFDocument): void {
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    const page = pdf.loadPage(p);
    const ws = safe(() => page.getWidgets(), []);
    for (const w of ws) {
      const field = fieldOf(w.getObject());
      const dv = safe(() => {
        const v = field.get("DV");
        return v.isString() ? v.asString() : v.isName() ? v.asName() : "";
      }, "");
      const type = typeOf(w);
      const cur = safe(() => String(w.getValue() ?? ""), "");
      if (safe(() => w.isReadOnly(), false) && !parseCalculation(js(field, "C"))) continue;
      if (type === "text" && cur !== dv) w.setTextValue(dv);
      else if ((type === "combobox" || type === "listbox") && cur !== dv) w.setChoiceValue(dv);
      else if (type === "checkbox" && cur !== "Off" && cur !== "" && cur !== dv) w.toggle();
      else if (type === "radio" && cur === onState(w.getObject()) && cur !== dv) w.toggle();
    }
    if (ws.length) page.update();
    page.destroy();
  }
  recalculate(pdf);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
