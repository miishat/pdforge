import { memo, useEffect, useRef, useState } from "react";
import type { AnnotationInfo, AnnotationPatch, NewAnnotation, PageSize, Point, Rect, ViewRotation } from "../../core/types";
import { rectToView, rotatedSize, toPage, toView } from "../geometry";
import {
  formatArea, formatLength, hexToColor, pathLength, polygonArea,
  type AnnotTool, type MeasureScale, type PlacePayload, type ToolStyle,
} from "./tools";

/** What a creation produces, minus the author (added by the caller). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Draft = DistributiveOmit<NewAnnotation, "author"> & { edit?: boolean };

interface Props {
  page: number;
  size: PageSize;
  rotation: ViewRotation;
  scale: number;
  annots: AnnotationInfo[];
  tool: AnnotTool | null;
  /** Whether existing annotations can be selected and changed. */
  editable: boolean;
  /** Notes can be opened even when not editable. */
  notesClickable: boolean;
  style: ToolStyle;
  measure: MeasureScale;
  stamp: string;
  place: PlacePayload | null;
  selectedId: number | null;
  editingId: number | null;
  onSelect: (page: number, id: number | null) => void;
  onCreate: (page: number, draft: Draft) => void;
  onPatch: (page: number, id: number, patch: AnnotationPatch) => void;
  onEdit: (page: number, id: number | null) => void;
  onCommitText: (page: number, id: number, text: string) => void;
  onSignBox: (page: number, rect: Rect) => void;
}

type Drag =
  | { kind: "shape"; start: Point; cur: Point }
  | { kind: "ink"; points: Point[] }
  | { kind: "move"; id: number; start: Point; cur: Point; moved: boolean }
  | { kind: "resize"; id: number; corner: number; rect: Rect; cur: Rect };

const RECT_TOOLS = new Set(["rect", "ellipse", "signbox"]);
const LINE_TOOLS = new Set(["line", "arrow", "distance", "callout"]);
const POLY_TOOLS = new Set(["polygon", "polyline", "perimeter", "area"]);

export const AnnotLayer = memo(function AnnotLayer(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [poly, setPoly] = useState<{ points: Point[]; cur: Point | null } | null>(null);
  const view = rotatedSize(p.size, p.rotation);

  // Local pixel ↔ page space.
  const toPagePt = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current!.getBoundingClientRect();
    const vx = Math.max(0, Math.min(view.width, (e.clientX - r.left) / p.scale));
    const vy = Math.max(0, Math.min(view.height, (e.clientY - r.top) / p.scale));
    return toPage([vx, vy], p.size, p.rotation);
  };
  const px = (pt: Point): Point => {
    const v = toView(pt, p.size, p.rotation);
    return [v[0] * p.scale, v[1] * p.scale];
  };
  const css = (r: Rect) => {
    const [x0, y0, x1, y1] = rectToView(r, p.size, p.rotation, p.scale);
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  };

  // Polygon tools: Enter finishes, Escape cancels.
  useEffect(() => {
    if (!poly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPoly(null);
      } else if (e.key === "Enter") finishPoly(poly.points);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poly]);

  useEffect(() => setPoly(null), [p.tool]);

  const color = hexToColor(p.style.color);
  const fill = p.style.fill ? hexToColor(p.style.fill) : null;
  const base = { color, opacity: p.style.opacity };

  function finishPoly(points: Point[]) {
    setPoly(null);
    const pts = dedupe(points);
    if (pts.length < 2) return;
    const t = p.tool!;
    if (t === "polygon" || t === "area") {
      if (pts.length < 3) return;
      p.onCreate(p.page, {
        type: "Polygon", vertices: pts, ...base, borderWidth: p.style.width, interiorColor: fill,
        ...(t === "area" ? { intent: "PolygonDimension" as const, contents: `Area: ${formatArea(polygonArea(pts), p.measure)}`, measure: p.measure } : {}),
      });
    } else {
      p.onCreate(p.page, {
        type: "PolyLine", vertices: pts, ...base, borderWidth: p.style.width,
        ...(t === "perimeter" ? { intent: "PolyLineDimension" as const, contents: `Perimeter: ${formatLength(pathLength(pts), p.measure)}`, measure: p.measure } : {}),
      });
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !p.tool) return;
    e.stopPropagation();
    const pt = toPagePt(e);
    const t = p.tool;
    if (POLY_TOOLS.has(t)) {
      if (e.detail >= 2 && poly) return finishPoly(poly.points);
      setPoly((cur) => ({ points: [...(cur?.points ?? []), pt], cur: pt }));
      return;
    }
    if (t === "note") return p.onCreate(p.page, { type: "Text", point: [pt[0] - 10, pt[1] - 10], ...base, edit: true });
    if (t === "text") {
      const fs = p.style.fontSize;
      return p.onCreate(p.page, { type: "FreeText", rect: [pt[0], pt[1] - fs * 0.8, pt[0] + 200, pt[1] + fs * 0.9], fontSize: fs, color, opacity: p.style.opacity, contents: "", edit: true });
    }
    if (t === "stamp") return p.onCreate(p.page, { type: "Stamp", rect: [pt[0] - 90, pt[1] - 28, pt[0] + 90, pt[1] + 28], icon: p.stamp, opacity: p.style.opacity });
    if (t === "place" && p.place) return place(pt, p.place);
    ref.current!.setPointerCapture(e.pointerId);
    if (t === "ink") setDrag({ kind: "ink", points: [pt] });
    else setDrag({ kind: "shape", start: pt, cur: pt });
  };

  function place(pt: Point, payload: PlacePayload) {
    if (payload.kind === "image") {
      const w = payload.width;
      const h = w / payload.aspect;
      p.onCreate(p.page, { type: "Stamp", rect: [pt[0] - w / 2, pt[1] - h / 2, pt[0] + w / 2, pt[1] + h / 2], image: payload.png, subject: payload.label });
    } else if (payload.kind === "text") {
      const fs = p.style.fontSize;
      const w = payload.text ? Math.max(40, payload.text.length * fs * 0.55 + 8) : 200;
      p.onCreate(p.page, { type: "FreeText", rect: [pt[0], pt[1] - fs * 0.8, pt[0] + w, pt[1] + fs * 0.9], fontSize: fs, color, contents: payload.text, edit: !payload.text });
    } else {
      const s = 7;
      const [x, y] = pt;
      if (payload.mark === "dot") p.onCreate(p.page, { type: "Circle", rect: [x - 3, y - 3, x + 3, y + 3], color, interiorColor: color, borderWidth: 1 });
      else
        p.onCreate(p.page, {
          type: "Ink",
          color,
          borderWidth: 1.8,
          strokes:
            payload.mark === "check"
              ? [[[x - s, y], [x - s / 3, y + s * 0.7], [x + s, y - s * 0.8]]]
              : [[[x - s * 0.7, y - s * 0.7], [x + s * 0.7, y + s * 0.7]], [[x + s * 0.7, y - s * 0.7], [x - s * 0.7, y + s * 0.7]]],
          subject: payload.label,
        });
    }
  }

  /** The drag with the pointer at `pt` (Shift keeps shapes straight or square). */
  const advance = (d: NonNullable<typeof drag>, pt: Point, shift: boolean): NonNullable<typeof drag> => {
    if (d.kind === "ink") return { kind: "ink", points: [...d.points, pt] };
    if (d.kind === "shape") return { ...d, cur: shift ? constrain(d.start, pt, p.tool!) : pt };
    if (d.kind === "move") return { ...d, cur: pt, moved: d.moved || Math.hypot(pt[0] - d.start[0], pt[1] - d.start[1]) > 1.5 };
    const r = [...d.rect] as Rect;
    // Corners: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left (page space).
    if (d.corner === 0 || d.corner === 3) r[0] = pt[0];
    else r[2] = pt[0];
    if (d.corner === 0 || d.corner === 1) r[1] = pt[1];
    else r[3] = pt[1];
    return { ...d, cur: r };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (poly) setPoly({ ...poly, cur: toPagePt(e) });
    if (drag) setDrag(advance(drag, toPagePt(e), e.shiftKey));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    // Finish where the pointer was let go: the last move may not have been drawn yet. (Ink keeps its own points.)
    const d = drag && (drag.kind === "ink" ? drag : advance(drag, toPagePt(e), e.shiftKey));
    setDrag(null);
    if (!d) return;
    const t = p.tool;
    if (d.kind === "move") {
      if (d.moved) p.onPatch(p.page, d.id, { translate: [d.cur[0] - d.start[0], d.cur[1] - d.start[1]] });
      return;
    }
    if (d.kind === "resize") {
      const r = norm(d.cur);
      if (r[2] - r[0] > 4 && r[3] - r[1] > 4) p.onPatch(p.page, d.id, { rect: r });
      return;
    }
    if (d.kind === "ink") {
      const pts = simplify(d.points);
      if (pts.length > 1) p.onCreate(p.page, { type: "Ink", strokes: [pts], ...base, borderWidth: p.style.width });
      return;
    }
    const { start, cur } = d;
    const len = Math.hypot(cur[0] - start[0], cur[1] - start[1]);
    if (len < 4 && t !== "callout") return;
    const r = norm([start[0], start[1], cur[0], cur[1]]);
    if (t === "signbox") return p.onSignBox(p.page, r);
    if (t === "rect") p.onCreate(p.page, { type: "Square", rect: r, ...base, borderWidth: p.style.width, interiorColor: fill });
    else if (t === "ellipse") p.onCreate(p.page, { type: "Circle", rect: r, ...base, borderWidth: p.style.width, interiorColor: fill });
    else if (t === "line") p.onCreate(p.page, { type: "Line", line: [start, cur], ...base, borderWidth: p.style.width });
    else if (t === "arrow") p.onCreate(p.page, { type: "Line", line: [start, cur], endings: ["None", "OpenArrow"], intent: "LineArrow", ...base, borderWidth: p.style.width });
    else if (t === "distance")
      p.onCreate(p.page, {
        type: "Line", line: [start, cur], endings: ["Butt", "Butt"], intent: "LineDimension", caption: true,
        contents: formatLength(len, p.measure), measure: p.measure, ...base, borderWidth: p.style.width,
      });
    else if (t === "callout") {
      const fs = p.style.fontSize;
      const end: Point = len < 4 ? [start[0] + 60, start[1] - 50] : cur;
      const box: Rect = [end[0], end[1] - fs, end[0] + 180, end[1] + fs * 1.4];
      p.onCreate(p.page, { type: "FreeText", rect: box, fontSize: fs, color, callout: [start, [end[0], end[1]]], contents: "", edit: true });
    }
  };

  const interactive = !!p.tool;
  const selected = p.annots.find((a) => a.id === p.selectedId) ?? null;

  return (
    <div
      ref={ref}
      className={`annot-layer ${interactive ? "annot-layer--drawing" : ""}`}
      data-tool={p.tool ?? undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {(p.editable || p.notesClickable) &&
        !interactive &&
        p.annots.map((a) => {
          if (a.hidden || (!p.editable && a.type !== "Text")) return null;
          const moving = drag?.kind === "move" && drag.id === a.id && drag.moved;
          const resizing = drag?.kind === "resize" && drag.id === a.id;
          let r = a.rect;
          if (moving) r = [r[0] + drag.cur[0] - drag.start[0], r[1] + drag.cur[1] - drag.start[1], r[2] + drag.cur[0] - drag.start[0], r[3] + drag.cur[1] - drag.start[1]];
          if (resizing) r = norm(drag.cur);
          const isSel = a.id === p.selectedId;
          return (
            <div
              key={a.id}
              className={`annot-hit ${isSel ? "annot-hit--selected" : ""} ${moving || resizing ? "annot-hit--dragging" : ""}`}
              data-type={a.type}
              data-id={a.id}
              role="button"
              aria-label={`${a.type}${a.contents ? `: ${a.contents}` : ""}`}
              aria-pressed={isSel}
              style={css(r)}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                p.onSelect(p.page, a.id);
                if (!p.editable) return;
                ref.current!.setPointerCapture(e.pointerId);
                const pt = toPagePt(e);
                setDrag({ kind: "move", id: a.id, start: pt, cur: pt, moved: false });
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (p.editable && (a.type === "FreeText" || a.type === "Text")) p.onEdit(p.page, a.id);
              }}
            >
              {isSel && p.editable && a.resizable &&
                [0, 1, 2, 3].map((c) => (
                  <span
                    key={c}
                    className={`annot-handle annot-handle--${c}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      ref.current!.setPointerCapture(e.pointerId);
                      setDrag({ kind: "resize", id: a.id, corner: cornerInPage(c, p.rotation), rect: a.rect, cur: a.rect });
                    }}
                  />
                ))}
            </div>
          );
        })}

      {p.annots.map((a) =>
        (a.intent === "PolygonDimension" || a.intent === "PolyLineDimension") && a.contents ? (
          <span key={`m${a.id}`} className="measure-label" style={{ left: css(a.rect).left + css(a.rect).width / 2, top: css(a.rect).top + css(a.rect).height / 2 }}>
            {a.contents.replace(/^(Area|Perimeter): /, "")}
          </span>
        ) : null,
      )}

      {p.editingId != null && selected?.type === "FreeText" && selected.id === p.editingId && (
        <FreeTextEditor
          key={selected.id}
          annot={selected}
          style={css(selected.rect)}
          scale={p.scale}
          onDone={(text) => p.onCommitText(p.page, selected.id, text)}
          onCancel={() => p.onEdit(p.page, null)}
        />
      )}

      <svg className="annot-preview" width={view.width * p.scale} height={view.height * p.scale}>
        {drag?.kind === "shape" && <ShapePreview tool={p.tool!} a={px(drag.start)} b={px(drag.cur)} style={p.style} scale={p.scale} label={p.tool === "distance" ? formatLength(Math.hypot(drag.cur[0] - drag.start[0], drag.cur[1] - drag.start[1]), p.measure) : null} />}
        {drag?.kind === "ink" && (
          <polyline points={drag.points.map(px).map((q) => q.join(",")).join(" ")} fill="none" stroke={p.style.color} strokeWidth={p.style.width * p.scale} strokeLinecap="round" strokeLinejoin="round" opacity={p.style.opacity} />
        )}
        {poly && (
          <>
            <polyline
              points={[...poly.points, ...(poly.cur ? [poly.cur] : [])].map(px).map((q) => q.join(",")).join(" ")}
              fill={p.style.fill && (p.tool === "polygon" || p.tool === "area") ? p.style.fill : "none"}
              fillOpacity={0.3}
              stroke={p.style.color}
              strokeWidth={Math.max(1, p.style.width * p.scale)}
            />
            {poly.points.map((q, i) => (
              <circle key={i} cx={px(q)[0]} cy={px(q)[1]} r={3.5} className="annot-preview__vertex" />
            ))}
          </>
        )}
      </svg>
      {poly && (p.tool === "area" || p.tool === "perimeter") && poly.points.length > 0 && (
        <span className="measure-label measure-label--live" style={{ left: px(poly.cur ?? poly.points[0])[0] + 12, top: px(poly.cur ?? poly.points[0])[1] + 12 }}>
          {p.tool === "area"
            ? formatArea(polygonArea([...poly.points, ...(poly.cur ? [poly.cur] : [])]), p.measure)
            : formatLength(pathLength([...poly.points, ...(poly.cur ? [poly.cur] : [])]), p.measure)}
        </span>
      )}
    </div>
  );
});

function ShapePreview({ tool, a, b, style, scale, label }: { tool: string; a: Point; b: Point; style: ToolStyle; scale: number; label: string | null }) {
  const sw = Math.max(1, style.width * scale);
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
  const common = { stroke: style.color, strokeWidth: sw, fill: style.fill ?? "none", fillOpacity: style.fill ? 0.9 : 0, opacity: style.opacity };
  if (tool === "signbox") return <rect x={x} y={y} width={w} height={h} className="annot-preview__signbox" />;
  if (RECT_TOOLS.has(tool) && tool === "rect") return <rect x={x} y={y} width={w} height={h} {...common} />;
  if (tool === "ellipse") return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
  if (LINE_TOOLS.has(tool))
    return (
      <g>
        <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={style.color} strokeWidth={sw} opacity={style.opacity} />
        {tool === "callout" && <rect x={b[0]} y={b[1] - 12} width={180 * (scale / 1.333)} height={28} fill="none" stroke={style.color} strokeDasharray="4 3" />}
        {label && (
          <text x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2 - 8} className="annot-preview__label" textAnchor="middle">
            {label}
          </text>
        )}
      </g>
    );
  return null;
}

function FreeTextEditor({ annot, style, scale, onDone, onCancel }: { annot: AnnotationInfo; style: React.CSSProperties; scale: number; onDone: (t: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(ref.current?.value ?? "");
  };
  const fs = (annot.fontSize ?? 12) * scale;
  return (
    <textarea
      ref={ref}
      className="freetext-editor"
      aria-label="Text box contents"
      defaultValue={annot.contents}
      style={{ ...style, fontSize: fs, lineHeight: 1.15, minHeight: fs * 1.6, color: annot.color ? `rgb(${annot.color.map((v) => v * 255).join(",")})` : undefined }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          done.current = true;
          onCancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish();
      }}
    />
  );
}

/** Corner index as seen on screen → corner in page space, so resizing follows the pointer when rotated. */
function cornerInPage(c: number, rotation: ViewRotation): number {
  return (c + rotation / 90 * 3) % 4;
}

function constrain(a: Point, b: Point, tool: string): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (tool === "rect" || tool === "ellipse") {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    return [a[0] + Math.sign(dx || 1) * s, a[1] + Math.sign(dy || 1) * s];
  }
  // Lines snap to 45°.
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
}

function norm([x0, y0, x1, y1]: Rect): Rect {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

function dedupe(pts: Point[]): Point[] {
  return pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 0.5);
}

/** Drops points closer than 1pt to keep ink annotations small. */
function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) >= 1) out.push(q);
  }
  return out;
}
