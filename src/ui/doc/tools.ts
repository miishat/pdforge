// Annotation tools, their default styles, and the colour palette.
import type { Color } from "../../core/types";
import { load, save } from "../settings";

export type Mode = "read" | "comment" | "fill" | "organize" | "edit";

export type AnnotTool =
  | "highlight" | "underline" | "strikeout" | "squiggly"
  | "note" | "text" | "callout"
  | "rect" | "ellipse" | "line" | "arrow" | "polygon" | "polyline" | "ink"
  | "stamp" | "distance" | "perimeter" | "area"
  | "place" | "signbox"
  | "edittext" | "addtext" | "editimage" | "addimage" | "link" | "redacttext" | "redactarea";

export const MARKUP_TOOLS = new Set<AnnotTool>(["highlight", "underline", "strikeout", "squiggly"]);
/** Tools that work by selecting text (the canvas runs text selection for them). */
export const SELECTION_TOOLS = new Set<AnnotTool>([...MARKUP_TOOLS, "redacttext"]);
/** Edit-mode tools handled by the page's edit layer. */
export const EDIT_TOOLS = new Set<AnnotTool>(["edittext", "addtext", "editimage", "addimage", "link", "redactarea"]);

/** Tuned to read well on white paper and as highlights (which multiply with the text). */
export const PALETTE: { name: string; hex: string }[] = [
  { name: "Yellow", hex: "#FFD33D" },
  { name: "Orange", hex: "#FF8A3D" },
  { name: "Red", hex: "#E5484D" },
  { name: "Pink", hex: "#E054A6" },
  { name: "Purple", hex: "#8E5BD9" },
  { name: "Blue", hex: "#2F7CF6" },
  { name: "Green", hex: "#2DA44E" },
  { name: "Graphite", hex: "#1F1C18" },
];

export interface ToolStyle {
  color: string;
  /** Fill for shapes; null = none. */
  fill: string | null;
  width: number;
  opacity: number;
  fontSize: number;
}

type StyleGroup = "highlight" | "underline" | "strikeout" | "squiggly" | "note" | "text" | "shape" | "ink" | "measure";

export function styleGroup(tool: AnnotTool | string): StyleGroup {
  if (tool === "highlight" || tool === "underline" || tool === "strikeout" || tool === "squiggly" || tool === "note") return tool;
  if (tool === "text" || tool === "callout" || tool === "addtext" || tool === "edittext") return "text";
  if (tool === "ink") return "ink";
  if (tool === "distance" || tool === "perimeter" || tool === "area") return "measure";
  return "shape";
}

const DEFAULTS: Record<StyleGroup, ToolStyle> = {
  highlight: { color: "#FFD33D", fill: null, width: 1, opacity: 1, fontSize: 12 },
  underline: { color: "#2DA44E", fill: null, width: 1, opacity: 1, fontSize: 12 },
  strikeout: { color: "#E5484D", fill: null, width: 1, opacity: 1, fontSize: 12 },
  squiggly: { color: "#E5484D", fill: null, width: 1, opacity: 1, fontSize: 12 },
  note: { color: "#FFD33D", fill: null, width: 1, opacity: 1, fontSize: 12 },
  text: { color: "#1F1C18", fill: null, width: 1, opacity: 1, fontSize: 12 },
  shape: { color: "#E5484D", fill: null, width: 2, opacity: 1, fontSize: 12 },
  ink: { color: "#2F7CF6", fill: null, width: 2, opacity: 1, fontSize: 12 },
  measure: { color: "#2F7CF6", fill: null, width: 1, opacity: 1, fontSize: 12 },
};

export function loadStyles(): Record<StyleGroup, ToolStyle> {
  const saved = load<Partial<Record<StyleGroup, ToolStyle>>>("annotStyles", {});
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, { ...v, ...saved[k as StyleGroup] }])) as Record<StyleGroup, ToolStyle>;
}

export function saveStyles(s: Record<StyleGroup, ToolStyle>) {
  save("annotStyles", s);
}

export function hexToColor(hex: string): Color {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function colorToHex(c: Color | null | undefined): string | null {
  if (!c) return null;
  return "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export const STAMPS = [
  { icon: "Approved", label: "Approved" },
  { icon: "NotApproved", label: "Not approved" },
  { icon: "Draft", label: "Draft" },
  { icon: "Final", label: "Final" },
  { icon: "Confidential", label: "Confidential" },
  { icon: "ForComment", label: "For comment" },
  { icon: "AsIs", label: "As is" },
  { icon: "Expired", label: "Expired" },
  { icon: "ForPublicRelease", label: "For public release" },
  { icon: "NotForPublicRelease", label: "Not for public release" },
  { icon: "TopSecret", label: "Top secret" },
  { icon: "Sold", label: "Sold" },
  { icon: "Departmental", label: "Departmental" },
  { icon: "Experimental", label: "Experimental" },
];

/** What a "place" click puts on the page in Fill & Sign. */
export type PlacePayload =
  | { kind: "image"; png: Uint8Array; aspect: number; width: number; label: string }
  | { kind: "text"; text: string; label: string }
  | { kind: "mark"; mark: "check" | "cross" | "dot"; label: string };

export interface MeasureScale {
  /** Real-world units per inch on the page. */
  ratio: number;
  unit: string;
}

export function formatLength(points: number, scale: MeasureScale): string {
  const v = (points / 72) * scale.ratio;
  return `${v.toFixed(v < 10 ? 2 : 1)} ${scale.unit}`;
}

export function formatArea(sqPoints: number, scale: MeasureScale): string {
  const v = (sqPoints / 5184) * scale.ratio * scale.ratio;
  return `${v.toFixed(v < 10 ? 2 : 1)} sq ${scale.unit}`;
}

export function polygonArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function pathLength(pts: [number, number][], closed = false): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 2) d += Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]);
  return d;
}

/** The tool that would create an annotation of this type (for picking its default style). */
export function typeToTool(type: string): AnnotTool {
  const map: Record<string, AnnotTool> = {
    Highlight: "highlight", Underline: "underline", StrikeOut: "strikeout", Squiggly: "squiggly", Text: "note",
    FreeText: "text", Square: "rect", Circle: "ellipse", Line: "line", Polygon: "polygon", PolyLine: "polyline",
    Ink: "ink", Stamp: "stamp",
  };
  return map[type] ?? "rect";
}
