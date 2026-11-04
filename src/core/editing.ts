// Annotation editing on top of MuPDF. All coordinates are page space (points, y down).
import * as mupdf from "mupdf";
import { ELEMENT_FOR_TYPE, TYPE_FOR_ELEMENT, hexColor, parseHexColor, type XfdfItem } from "./xfdf";
import type { AnnotationInfo, AnnotationPatch, Color, MeasureScale, NewAnnotation, Point, Quad, Rect } from "./types";

/** Types PDForge lists and lets people edit. Links, form widgets and popups are handled elsewhere. */
const EDITABLE = new Set([
  "Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline",
  "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink", "FileAttachment", "Redact", "Sound",
]);
const RESIZABLE = new Set(["Square", "Circle", "FreeText", "Stamp"]);
const FLAG_HIDDEN = 2;
const FLAG_PRINT = 4;
const FLAG_NO_ZOOM = 8;
const FLAG_NO_ROTATE = 16;

export function describe(a: mupdf.PDFAnnotation, page: number): AnnotationInfo | null {
  const type = safe(() => a.getType(), "Unknown");
  if (!EDITABLE.has(type)) return null;
  const obj = a.getObject();
  const irt = safe(() => obj.get("IRT"), null);
  const flags = safe(() => a.getFlags(), 0);
  const da = type === "FreeText" ? safe(() => a.getDefaultAppearance(), null) : null;
  return {
    id: obj.asIndirect(),
    page,
    type,
    rect: safe(() => a.getBounds() as Rect, [0, 0, 0, 0] as Rect),
    contents: safe(() => a.getContents(), ""),
    author: safe(() => (a.hasAuthor() ? a.getAuthor() : ""), ""),
    subject: safe(() => (a.hasSubject() ? a.getSubject() : ""), ""),
    modified: safe(() => validDate(a.getModificationDate()), null),
    created: safe(() => validDate(a.getCreationDate()), null),
    color: toColor(safe(() => a.getColor(), [])),
    interiorColor: safe(() => (a.hasInteriorColor() ? toColor(a.getInteriorColor()) : null), null),
    opacity: safe(() => a.getOpacity(), 1),
    borderWidth: safe(() => (a.hasBorder() ? a.getBorderWidth() : 0), 0),
    inReplyTo: irt && irt.isIndirect() ? irt.asIndirect() : null,
    state: safe(() => {
      const st = obj.get("State");
      return st.isString() ? st.asString() : null;
    }, null),
    icon: safe(() => (a.hasIcon() ? a.getIcon() : null), null),
    intent: safe(() => a.getIntent(), null),
    lineEndings: safe(() => {
      if (!a.hasLineEndingStyles()) return null;
      const le = a.getLineEndingStyles();
      return [le.start, le.end] as [string, string];
    }, null),
    fontSize: da ? da.size : null,
    hidden: (flags & FLAG_HIDDEN) !== 0 || !!(irt && irt.isIndirect()),
    resizable: RESIZABLE.has(type),
  };
}

export function listAnnotations(pdf: mupdf.PDFDocument, pages?: number[]): AnnotationInfo[] {
  const out: AnnotationInfo[] = [];
  const list = pages ?? Array.from({ length: pdf.countPages() }, (_, i) => i);
  for (const p of list) {
    const page = pdf.loadPage(p);
    for (const a of safe(() => page.getAnnotations(), [])) {
      const info = describe(a, p);
      if (info) out.push(info);
    }
    page.destroy();
  }
  return out;
}

export function findAnnotation(page: mupdf.PDFPage, id: number): mupdf.PDFAnnotation {
  const a = page.getAnnotations().find((x) => x.getObject().asIndirect() === id);
  if (!a) throw new Error("That comment no longer exists.");
  return a;
}

export function createAnnotation(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, spec: NewAnnotation): mupdf.PDFAnnotation {
  const a = page.createAnnotation(spec.type);
  const now = new Date();
  a.setAuthor(spec.author);
  safe(() => a.setCreationDate(now), undefined);
  a.setModificationDate(now);
  if (spec.contents) a.setContents(spec.contents);
  if (spec.subject) a.setSubject(spec.subject);
  switch (spec.type) {
    case "Highlight":
    case "Underline":
    case "StrikeOut":
    case "Squiggly":
      a.setQuadPoints(spec.quads as mupdf.Quad[]);
      break;
    case "Text": {
      const [x, y] = spec.point;
      a.setRect([x, y, x + 20, y + 20]);
      if (spec.icon) a.setIcon(spec.icon);
      break;
    }
    case "FreeText":
      a.setRect(spec.rect);
      a.setDefaultAppearance("Helv", spec.fontSize, spec.color ?? [0, 0, 0]);
      if (spec.callout?.length) {
        a.setIntent("FreeTextCallout");
        a.setCalloutLine(spec.callout as mupdf.Point[]);
      } else a.setIntent("FreeTextTypeWriter");
      break;
    case "Square":
    case "Circle":
      a.setRect(spec.rect);
      break;
    case "Line":
      a.setLine(spec.line[0], spec.line[1]);
      if (spec.endings) a.setLineEndingStyles(spec.endings[0] as never, spec.endings[1] as never);
      if (spec.intent) a.setIntent(spec.intent);
      if (spec.caption) a.setLineCaption(true);
      if (spec.measure) putMeasure(pdf, a, spec.measure);
      break;
    case "Polygon":
    case "PolyLine":
      a.setVertices(spec.vertices as mupdf.Point[]);
      if (spec.intent) a.setIntent(spec.intent as never);
      if (spec.measure) putMeasure(pdf, a, spec.measure);
      break;
    case "Ink":
      a.setInkList(spec.strokes as mupdf.Point[][]);
      break;
    case "Stamp":
      a.setRect(spec.rect);
      if (spec.image) {
        a.setStampImage(new mupdf.Image(spec.image));
        a.setIntent("StampImage");
      } else a.setIcon(spec.icon ?? "Draft");
      break;
  }
  applyStyle(a, spec, spec.type);
  ensureName(pdf, a);
  a.update();
  return a;
}

export function patchAnnotation(a: mupdf.PDFAnnotation, patch: AnnotationPatch): void {
  const type = a.getType();
  if (patch.translate) translate(a, patch.translate);
  if (patch.rect) {
    if (a.hasRect()) a.setRect(normalize(patch.rect));
    else if (type === "Ink") scaleInk(a, normalize(patch.rect));
  }
  if (patch.contents !== undefined) a.setContents(patch.contents);
  if (patch.author !== undefined) a.setAuthor(patch.author);
  if (patch.lineEndings && a.hasLineEndingStyles()) a.setLineEndingStyles(patch.lineEndings[0] as never, patch.lineEndings[1] as never);
  if (type === "FreeText" && (patch.fontSize !== undefined || patch.color)) {
    const da = a.getDefaultAppearance();
    a.setDefaultAppearance(da.font || "Helv", patch.fontSize ?? da.size, (patch.color ?? (da.color as Color)) as mupdf.AnnotColor);
  }
  applyStyle(a, patch, type);
  a.setModificationDate(new Date());
  a.update();
}

function applyStyle(a: mupdf.PDFAnnotation, s: { color?: Color; interiorColor?: Color | null; opacity?: number; borderWidth?: number }, type: string) {
  // Free text keeps its text colour in the default appearance, not in /C (which would add a border).
  if (s.color && type !== "FreeText") a.setColor(s.color);
  if (s.interiorColor !== undefined && a.hasInteriorColor()) a.setInteriorColor(s.interiorColor ?? []);
  if (s.opacity !== undefined) a.setOpacity(s.opacity);
  if (s.borderWidth !== undefined && a.hasBorder()) a.setBorderWidth(s.borderWidth);
}

function translate(a: mupdf.PDFAnnotation, [dx, dy]: Point) {
  const mv = ([x, y]: Point): Point => [x + dx, y + dy];
  if (a.hasQuadPoints()) {
    a.setQuadPoints(a.getQuadPoints().map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)) as unknown as mupdf.Quad));
  } else if (a.hasInkList()) {
    a.setInkList(a.getInkList().map((s) => s.map((p) => mv(p as Point))) as mupdf.Point[][]);
  } else if (a.hasVertices()) {
    a.setVertices(a.getVertices().map((p) => mv(p as Point)) as mupdf.Point[]);
  } else if (a.hasLine()) {
    const [p, q] = a.getLine();
    a.setLine(mv(p as Point), mv(q as Point));
  } else {
    const [x0, y0, x1, y1] = a.getRect();
    a.setRect([x0 + dx, y0 + dy, x1 + dx, y1 + dy]);
    if (a.hasCallout()) {
      const line = a.getCalloutLine();
      // The callout's arrow tip stays on its target; the rest follows the box.
      if (line && line.length > 1) a.setCalloutLine([line[0], ...line.slice(1).map((p) => mv(p as Point))] as mupdf.Point[]);
    }
  }
}

function scaleInk(a: mupdf.PDFAnnotation, to: Rect) {
  const from = a.getBounds();
  const sx = (to[2] - to[0]) / Math.max(1, from[2] - from[0]);
  const sy = (to[3] - to[1]) / Math.max(1, from[3] - from[1]);
  a.setInkList(a.getInkList().map((s) => s.map(([x, y]) => [to[0] + (x - from[0]) * sx, to[1] + (y - from[1]) * sy])) as mupdf.Point[][]);
}

/** Adds a reply (or a review-state change) to a comment, as Acrobat does: a hidden Text annotation with /IRT. */
export function addReply(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, parent: mupdf.PDFAnnotation, text: string, author: string, state?: string) {
  const r = page.createAnnotation("Text");
  const [x0, y0] = parent.getBounds();
  r.setRect([x0, y0, x0 + 20, y0 + 20]);
  r.setAuthor(author);
  r.setContents(text);
  const now = new Date();
  safe(() => r.setCreationDate(now), undefined);
  r.setModificationDate(now);
  const obj = r.getObject();
  ensureName(pdf, parent);
  ensureName(pdf, r);
  obj.put("IRT", parent.getObject());
  if (state) {
    obj.put("State", pdf.newString(state));
    obj.put("StateModel", pdf.newString("Review"));
  }
  r.setFlags(FLAG_PRINT | FLAG_NO_ZOOM | FLAG_NO_ROTATE);
  // Replies live in the comments list, not on the page: give them an empty appearance.
  obj.put("AP", { N: pdf.addStream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 0, 0] }) });
  return r;
}

/** Deletes an annotation and its whole reply thread. */
export function deleteWithReplies(page: mupdf.PDFPage, target: mupdf.PDFAnnotation) {
  const doomed = new Set([target.getObject().asIndirect()]);
  let grew = true;
  const all = page.getAnnotations();
  while (grew) {
    grew = false;
    for (const a of all) {
      const id = a.getObject().asIndirect();
      const irt = safe(() => a.getObject().get("IRT"), null);
      if (!doomed.has(id) && irt?.isIndirect() && doomed.has(irt.asIndirect())) {
        doomed.add(id);
        grew = true;
      }
    }
  }
  // Deleting changes the page's annotation list, so look the next one up afresh each time.
  for (;;) {
    const next = page.getAnnotations().find((a) => doomed.has(a.getObject().asIndirect()));
    if (!next) break;
    page.deleteAnnotation(next);
  }
}

function putMeasure(pdf: mupdf.PDFDocument, a: mupdf.PDFAnnotation, m: MeasureScale) {
  // A minimal /Measure dictionary so other viewers recognise it as a measurement.
  const perPoint = m.ratio / 72;
  const fmt = { Type: "NumberFormat", U: pdf.newString(m.unit), C: perPoint, D: 100 };
  a.getObject().put("Measure", {
    Type: "Measure",
    Subtype: "RL",
    R: pdf.newString(`1 in = ${m.ratio} ${m.unit}`),
    X: [fmt],
    D: [fmt],
    A: [{ ...fmt, U: pdf.newString(`sq ${m.unit}`), C: perPoint * perPoint }],
  });
}

export function quadsFromRects(rects: Rect[]): Quad[] {
  return rects.map(([x0, y0, x1, y1]) => [x0, y0, x1, y0, x0, y1, x1, y1]);
}

function normalize([x0, y0, x1, y1]: Rect): Rect {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

function toColor(c: number[] | undefined | null): Color | null {
  if (!c || !c.length) return null;
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) {
    const [C, M, Y, K] = c;
    return [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)];
  }
  return [c[0], c[1], c[2]];
}

export function validDate(d: Date): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1990 ? d.toISOString() : null;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---- XFDF exchange ----


type M = mupdf.Matrix;
const apply = (m: M, [x, y]: Point): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function rectThrough(m: M, r: Rect): Rect {
  const t = mupdf.Rect.transform(r, m);
  return [Math.min(t[0], t[2]), Math.min(t[1], t[3]), Math.max(t[0], t[2]), Math.max(t[1], t[3])];
}

/** A stable unique name (/NM), used to link replies in XFDF. */
export function ensureName(pdf: mupdf.PDFDocument, a: mupdf.PDFAnnotation): string {
  const obj = a.getObject();
  const nm = safe(() => obj.get("NM"), null);
  if (nm && nm.isString() && nm.asString()) return nm.asString();
  const name = `pdforge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  obj.put("NM", pdf.newString(name));
  return name;
}

function pdfDateString(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function exportItems(pdf: mupdf.PDFDocument): XfdfItem[] {
  const items: XfdfItem[] = [];
  const names = new Map<number, string>();
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    const page = pdf.loadPage(p);
    const toPdf = mupdf.Matrix.invert(page.getTransform());
    for (const a of safe(() => page.getAnnotations(), [])) {
      const info = describe(a, p);
      if (!info || !ELEMENT_FOR_TYPE[info.type]) continue;
      const obj = a.getObject();
      const nm = safe(() => (obj.get("NM").isString() ? obj.get("NM").asString() : ""), "") || `pdforge-${info.id}`;
      names.set(info.id, nm);
      const item: XfdfItem = {
        element: ELEMENT_FOR_TYPE[info.type],
        page: p,
        name: nm,
        rect: rectThrough(toPdf, info.rect),
        color: info.type === "FreeText" ? undefined : hexColor(info.color),
        interiorColor: hexColor(info.interiorColor),
        opacity: info.opacity,
        width: info.borderWidth || undefined,
        title: info.author || undefined,
        subject: info.subject || undefined,
        contents: info.contents || undefined,
        created: pdfDateString(info.created),
        modified: pdfDateString(info.modified),
        icon: info.icon ?? undefined,
        state: info.state ?? undefined,
        stateModel: info.state ? "Review" : undefined,
        intent: info.intent ?? undefined,
      };
      if (info.inReplyTo != null) item.inReplyTo = String(info.inReplyTo);
      if (a.hasQuadPoints()) item.coords = a.getQuadPoints().flatMap((q) => {
        const pts: Point[] = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]];
        return pts.flatMap((pt) => apply(toPdf, pt));
      });
      if (a.hasLine()) {
        const [s, e] = a.getLine();
        item.start = apply(toPdf, s as Point);
        item.end = apply(toPdf, e as Point);
        if (info.lineEndings) [item.head, item.tail] = info.lineEndings;
      }
      if (a.hasVertices()) item.vertices = a.getVertices().map((v) => apply(toPdf, v as Point));
      if (a.hasInkList()) item.ink = a.getInkList().map((s) => s.map((v) => apply(toPdf, v as Point)));
      if (info.type === "FreeText") {
        const da = safe(() => a.getDefaultAppearance(), null);
        if (da) {
          const c = toColor(da.color as number[]) ?? [0, 0, 0];
          item.defaultAppearance = `/Helv ${da.size} Tf ${c.map((v) => Math.round(v * 1000) / 1000).join(" ")} rg`;
        }
        const callout = info.intent === "FreeTextCallout" ? safe(() => a.getCalloutLine(), null) : null;
        if (callout?.length) item.callout = callout.map((v) => apply(toPdf, v as Point));
      }
      items.push(item);
    }
    page.destroy();
  }
  // Replies reference their parent's name.
  for (const it of items) if (it.inReplyTo) it.inReplyTo = names.get(Number(it.inReplyTo)) ?? it.inReplyTo;
  return items;
}

/** Creates annotations from XFDF items. Returns the pages that changed and how many were skipped. */
export function importItems(pdf: mupdf.PDFDocument, items: XfdfItem[], fallbackAuthor: string): { pages: number[]; imported: number; skipped: number } {
  const byName = new Map<string, { page: number; a: mupdf.PDFAnnotation }>();
  const pages = new Set<number>();
  let imported = 0;
  let skipped = 0;
  const n = pdf.countPages();
  // Parents first, so replies can find them.
  const ordered = [...items.filter((i) => !i.inReplyTo), ...items.filter((i) => i.inReplyTo)];
  for (const it of ordered) {
    if (it.page < 0 || it.page >= n) {
      skipped++;
      continue;
    }
    const page = pdf.loadPage(it.page);
    const toPage = page.getTransform();
    const P = (pt: [number, number]) => apply(toPage, pt);
    const R = (r: number[]) => rectThrough(toPage, [r[0], r[1], r[2], r[3]]);
    const author = it.title || fallbackAuthor;
    const color = parseHexColor(it.color);
    const style = {
      color,
      interiorColor: parseHexColor(it.interiorColor) ?? undefined,
      opacity: it.opacity,
      borderWidth: it.width,
    };
    try {
      if (it.inReplyTo) {
        const parent = byName.get(it.inReplyTo) ?? findByName(pdf, it.inReplyTo);
        if (!parent) {
          skipped++;
          continue;
        }
        const r = addReply(pdf, pdf.loadPage(parent.page), parent.a, it.contents ?? "", author, it.state);
        byName.set(it.name, { page: parent.page, a: r });
        imported++;
        pages.add(parent.page);
        continue;
      }
      const type = TYPE_FOR_ELEMENT[it.element];
      const base = { author, contents: it.contents, subject: it.subject, ...style };
      let spec: NewAnnotation | null = null;
      if (["Highlight", "Underline", "StrikeOut", "Squiggly"].includes(type) && it.coords) {
        const quads: Quad[] = [];
        for (let i = 0; i + 7 < it.coords.length; i += 8) {
          const c = it.coords;
          const pts = [P([c[i], c[i + 1]]), P([c[i + 2], c[i + 3]]), P([c[i + 4], c[i + 5]]), P([c[i + 6], c[i + 7]])];
          quads.push(pts.flat() as Quad);
        }
        spec = { ...base, type: type as "Highlight", quads };
      } else if (type === "Text") {
        const r = R(it.rect);
        spec = { ...base, type: "Text", point: [r[0], r[1]], icon: it.icon };
      } else if (type === "FreeText") {
        const m = /([\d.]+)\s+Tf(?:\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg)?/.exec(it.defaultAppearance ?? "");
        spec = {
          ...base,
          type: "FreeText",
          rect: R(it.rect),
          fontSize: m ? Number(m[1]) : 12,
          color: m && m[2] ? [Number(m[2]), Number(m[3]), Number(m[4])] : color,
          callout: it.callout?.map(P),
        };
      } else if (type === "Square" || type === "Circle") {
        spec = { ...base, type, rect: R(it.rect) };
      } else if (type === "Line" && it.start && it.end) {
        spec = {
          ...base,
          type: "Line",
          line: [P(it.start), P(it.end)],
          endings: [it.head ?? "None", it.tail ?? "None"],
          intent: it.intent === "LineArrow" || it.intent === "LineDimension" ? it.intent : undefined,
          caption: it.intent === "LineDimension",
        };
      } else if ((type === "Polygon" || type === "PolyLine") && it.vertices) {
        spec = { ...base, type, vertices: it.vertices.map(P) };
      } else if (type === "Ink" && it.ink) {
        spec = { ...base, type: "Ink", strokes: it.ink.map((g) => g.map(P)) };
      } else if (type === "Stamp") {
        spec = { ...base, type: "Stamp", rect: R(it.rect), icon: it.icon ?? "Draft" };
      }
      if (!spec) {
        skipped++;
        continue;
      }
      const a = createAnnotation(pdf, page, spec);
      if (it.name) a.getObject().put("NM", pdf.newString(it.name));
      byName.set(it.name, { page: it.page, a });
      pages.add(it.page);
      imported++;
    } catch {
      skipped++;
    }
  }
  return { pages: [...pages], imported, skipped };
}

function findByName(pdf: mupdf.PDFDocument, name: string): { page: number; a: mupdf.PDFAnnotation } | null {
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    const page = pdf.loadPage(p);
    for (const a of safe(() => page.getAnnotations(), [])) {
      const nm = safe(() => a.getObject().get("NM"), null);
      if (nm?.isString() && nm.asString() === name) return { page: p, a };
    }
  }
  return null;
}
