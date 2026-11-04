// XFDF (XML Forms Data Format) comment export/import, compatible with Acrobat's "Export/Import comments".
// Coordinates in XFDF are PDF user space (origin bottom-left, y up).

export interface XfdfItem {
  /** XFDF element name: text, highlight, freetext, ink, … */
  element: string;
  page: number;
  name: string;
  inReplyTo?: string;
  rect: number[];
  color?: string;
  interiorColor?: string;
  opacity?: number;
  width?: number;
  title?: string;
  subject?: string;
  contents?: string;
  created?: string;
  modified?: string;
  icon?: string;
  state?: string;
  stateModel?: string;
  intent?: string;
  /** Flat quad points (markup). */
  coords?: number[];
  start?: [number, number];
  end?: [number, number];
  head?: string;
  tail?: string;
  vertices?: [number, number][];
  ink?: [number, number][][];
  /** FreeText default appearance, e.g. "/Helv 12 Tf 0 0 0 rg". */
  defaultAppearance?: string;
  callout?: [number, number][];
}

export const ELEMENT_FOR_TYPE: Record<string, string> = {
  Text: "text", FreeText: "freetext", Highlight: "highlight", Underline: "underline", StrikeOut: "strikeout",
  Squiggly: "squiggly", Square: "square", Circle: "circle", Line: "line", Polygon: "polygon", PolyLine: "polyline",
  Ink: "ink", Stamp: "stamp", Caret: "caret",
};
export const TYPE_FOR_ELEMENT = Object.fromEntries(Object.entries(ELEMENT_FOR_TYPE).map(([k, v]) => [v, k]));

const n = (x: number) => String(Math.round(x * 1000) / 1000);
const pt = (p: [number, number]) => `${n(p[0])},${n(p[1])}`;

export function toXfdf(items: XfdfItem[], fileName: string): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">', "<annots>"];
  for (const it of items) {
    const attrs: Record<string, string | undefined> = {
      page: String(it.page),
      name: it.name,
      inreplyto: it.inReplyTo,
      rect: it.rect.map(n).join(","),
      color: it.color,
      "interior-color": it.interiorColor,
      opacity: it.opacity !== undefined && it.opacity < 1 ? n(it.opacity) : undefined,
      width: it.width !== undefined ? n(it.width) : undefined,
      title: it.title,
      subject: it.subject,
      creationdate: it.created,
      date: it.modified,
      icon: it.icon,
      state: it.state,
      statemodel: it.stateModel,
      intent: it.intent,
      coords: it.coords?.map(n).join(","),
      start: it.start && pt(it.start),
      end: it.end && pt(it.end),
      head: it.head,
      tail: it.tail,
      callout: it.callout?.map(pt).join(","),
    };
    const a = Object.entries(attrs)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => ` ${k}="${esc(v!)}"`)
      .join("");
    const children: string[] = [];
    if (it.contents) children.push(`<contents>${esc(it.contents)}</contents>`);
    if (it.defaultAppearance) children.push(`<defaultappearance>${esc(it.defaultAppearance)}</defaultappearance>`);
    if (it.vertices) children.push(`<vertices>${it.vertices.map(pt).join(";")}</vertices>`);
    if (it.ink) children.push(`<inklist>${it.ink.map((g) => `<gesture>${g.map(pt).join(";")}</gesture>`).join("")}</inklist>`);
    out.push(children.length ? `<${it.element}${a}>${children.join("")}</${it.element}>` : `<${it.element}${a}/>`);
  }
  out.push("</annots>", `<f href="${esc(fileName)}"/>`, "</xfdf>");
  return out.join("\n");
}

export function fromXfdf(xml: string): XfdfItem[] {
  const root = parseXml(xml);
  if (root.name.replace(/^.*:/, "") !== "xfdf") throw new Error("This isn't an XFDF comments file.");
  const annots = root.children.find((c) => c.name.replace(/^.*:/, "") === "annots");
  if (!annots) return [];
  const items: XfdfItem[] = [];
  for (const el of annots.children) {
    const element = el.name.replace(/^.*:/, "").toLowerCase();
    if (!TYPE_FOR_ELEMENT[element]) continue;
    const a = el.attrs;
    const nums = (s?: string) => (s ? s.split(/[,\s;]+/).filter(Boolean).map(Number) : undefined);
    const pair = (s?: string) => {
      const v = nums(s);
      return v && v.length >= 2 ? ([v[0], v[1]] as [number, number]) : undefined;
    };
    const pairs = (s?: string) => {
      const v = nums(s) ?? [];
      const out: [number, number][] = [];
      for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]);
      return out;
    };
    const child = (name: string) => el.children.find((c) => c.name.replace(/^.*:/, "") === name);
    const text = (name: string) => {
      const c = child(name);
      return c ? textOf(c) : undefined;
    };
    const inklist = child("inklist");
    items.push({
      element,
      page: Number(a.page ?? 0),
      name: a.name ?? "",
      inReplyTo: a.inreplyto,
      rect: nums(a.rect) ?? [0, 0, 0, 0],
      color: a.color,
      interiorColor: a["interior-color"],
      opacity: a.opacity !== undefined ? Number(a.opacity) : undefined,
      width: a.width !== undefined ? Number(a.width) : undefined,
      title: a.title,
      subject: a.subject,
      contents: text("contents") ?? text("contents-richtext"),
      created: a.creationdate,
      modified: a.date,
      icon: a.icon,
      state: a.state,
      stateModel: a.statemodel,
      intent: a.intent,
      coords: nums(a.coords),
      start: pair(a.start),
      end: pair(a.end),
      head: a.head,
      tail: a.tail,
      vertices: text("vertices") !== undefined ? pairs(text("vertices")) : undefined,
      ink: inklist ? inklist.children.filter((g) => g.name.replace(/^.*:/, "") === "gesture").map((g) => pairs(textOf(g))) : undefined,
      defaultAppearance: text("defaultappearance"),
      callout: a.callout ? pairs(a.callout) : undefined,
    });
  }
  return items;
}

export function hexColor(c: [number, number, number] | null | undefined): string | undefined {
  if (!c) return undefined;
  return "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function parseHexColor(s: string | undefined): [number, number, number] | undefined {
  const m = s && /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/\r?\n/g, "&#10;");
}

// ---- Minimal XML parser (elements, attributes, text, CDATA, entities). Enough for XFDF; no DTDs. ----

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function textOf(n: XmlNode): string {
  // Rich text contents: collect all nested text.
  return n.text + n.children.map(textOf).join("");
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()]!;
  });
}

export function parseXml(xml: string): XmlNode {
  const src = xml.replace(/^﻿/, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new Error("XML with a DOCTYPE isn't accepted.");
  const stack: XmlNode[] = [{ name: "#root", attrs: {}, children: [], text: "" }];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length < 2 || top.name !== m[2]) throw new Error(`Unexpected </${m[2]}> in XML.`);
      stack.pop();
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name: m[3], attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) throw new Error("The XML file is incomplete.");
  const root = stack[0].children[0];
  if (!root) throw new Error("The XML file is empty.");
  return root;
}
