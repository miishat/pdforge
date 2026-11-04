import { memo, useEffect, useRef, useState } from "react";
import type { ImageInfo, TextLine } from "../../core/content";
import type { LinkInfo, PageSize, Point, Rect, ViewRotation } from "../../core/types";
import { rectToView, rotatedSize, toPage } from "../geometry";
import type { AnnotTool } from "./tools";

interface Props {
  page: number;
  size: PageSize;
  rotation: ViewRotation;
  scale: number;
  tool: AnnotTool;
  lines: TextLine[];
  images: ImageInfo[];
  links: LinkInfo[];
  selectedImage: number | null;
  selectedLink: number | null;
  textStyle: { size: number; color: string; family: "sans" | "serif" | "mono"; bold: boolean; italic: boolean };
  onEditLine: (page: number, line: TextLine, text: string) => void;
  onAddText: (page: number, origin: Point, text: string) => void;
  onSelectImage: (page: number, index: number | null) => void;
  onMoveImage: (page: number, index: number, rect: Rect) => void;
  onAddImageArea: (page: number, rect: Rect) => void;
  onSelectLink: (page: number, index: number | null) => void;
  onLinkArea: (page: number, rect: Rect) => void;
  onRedactArea: (page: number, rect: Rect) => void;
}

type Drag =
  | { kind: "area"; start: Point; cur: Point }
  | { kind: "move"; index: number; start: Point; cur: Point; moved: boolean }
  | { kind: "resize"; index: number; corner: number; rect: Rect; cur: Rect };

const FONT: Record<string, string> = {
  sans: "Helvetica, Arial, sans-serif",
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};

/** Edit-mode interactions on one page: text lines, new text, images, links, redaction areas. */
export const EditLayer = memo(function EditLayer(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState<Point | null>(null);
  const view = rotatedSize(p.size, p.rotation);

  useEffect(() => {
    setEditing(null);
    setAdding(null);
  }, [p.tool]);

  const pt = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current!.getBoundingClientRect();
    const vx = Math.max(0, Math.min(view.width, (e.clientX - r.left) / p.scale));
    const vy = Math.max(0, Math.min(view.height, (e.clientY - r.top) / p.scale));
    return toPage([vx, vy], p.size, p.rotation);
  };
  const css = (r: Rect) => {
    const [x0, y0, x1, y1] = rectToView(r, p.size, p.rotation, p.scale);
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  };
  const areaTool = p.tool === "addimage" || p.tool === "link" || p.tool === "redactarea";

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (p.tool === "addtext") {
      if (!adding) setAdding(pt(e));
      return;
    }
    if (areaTool) {
      ref.current!.setPointerCapture(e.pointerId);
      const s = pt(e);
      setDrag({ kind: "area", start: s, cur: s });
      return;
    }
    if (p.tool === "editimage") p.onSelectImage(p.page, null);
    if (p.tool === "link") p.onSelectLink(p.page, null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const q = pt(e);
    if (drag.kind === "area") setDrag({ ...drag, cur: q });
    else if (drag.kind === "move") setDrag({ ...drag, cur: q, moved: drag.moved || Math.hypot(q[0] - drag.start[0], q[1] - drag.start[1]) > 1.5 });
    else {
      const r = [...drag.rect] as Rect;
      if (drag.corner === 0 || drag.corner === 3) r[0] = q[0];
      else r[2] = q[0];
      if (drag.corner === 0 || drag.corner === 1) r[1] = q[1];
      else r[3] = q[1];
      // Images keep their proportions when resized.
      const aspect = (drag.rect[2] - drag.rect[0]) / (drag.rect[3] - drag.rect[1]);
      const w = Math.abs(r[2] - r[0]);
      const h = w / aspect;
      if (drag.corner === 0 || drag.corner === 1) r[1] = r[3] - h;
      else r[3] = r[1] + h;
      setDrag({ ...drag, cur: r });
    }
  };

  const onPointerUp = () => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.kind === "area") {
      const r = norm([d.start[0], d.start[1], d.cur[0], d.cur[1]]);
      const small = r[2] - r[0] < 6 || r[3] - r[1] < 6;
      if (p.tool === "addimage") p.onAddImageArea(p.page, small ? [r[0], r[1], r[0] + 200, r[1] + 150] : r);
      else if (small) return;
      else if (p.tool === "link") p.onLinkArea(p.page, r);
      else if (p.tool === "redactarea") p.onRedactArea(p.page, r);
    } else if (d.kind === "move" && d.moved) {
      const img = p.images[d.index];
      const dx = d.cur[0] - d.start[0];
      const dy = d.cur[1] - d.start[1];
      p.onMoveImage(p.page, d.index, [img.rect[0] + dx, img.rect[1] + dy, img.rect[2] + dx, img.rect[3] + dy]);
    } else if (d.kind === "resize") {
      const r = norm(d.cur);
      if (r[2] - r[0] > 4 && r[3] - r[1] > 4) p.onMoveImage(p.page, d.index, r);
    }
  };

  return (
    <div
      ref={ref}
      className="edit-layer"
      data-tool={p.tool}
      onPointerDown={onPointerDown}
      // Keep focus on our editors: a mousedown here would otherwise focus the scroll area behind.
      onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {p.tool === "edittext" &&
        p.lines.map((l) =>
          editing === l.index ? (
            <LineEditor key={`e${l.index}`} line={l} style={css(l.rect)} scale={p.scale} onDone={(t) => (setEditing(null), t !== l.text && p.onEditLine(p.page, l, t))} onCancel={() => setEditing(null)} />
          ) : (
            <div
              key={l.index}
              className={`edit-line ${l.editable ? "" : "edit-line--locked"}`}
              style={css(l.rect)}
              title={l.editable ? `${l.font}, ${l.size} pt. Click to edit.` : l.reason ?? undefined}
              role="button"
              aria-label={`Edit text: ${l.text}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (l.editable) setEditing(l.index);
              }}
              onMouseDown={(e) => e.preventDefault()}
            />
          ),
        )}

      {p.tool === "editimage" &&
        p.images.map((img) => {
          let r = img.rect;
          if (drag?.kind === "move" && drag.index === img.index && drag.moved) {
            const dx = drag.cur[0] - drag.start[0];
            const dy = drag.cur[1] - drag.start[1];
            r = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
          }
          if (drag?.kind === "resize" && drag.index === img.index) r = norm(drag.cur);
          const sel = p.selectedImage === img.index;
          return (
            <div
              key={img.index}
              className={`edit-image ${sel ? "edit-image--selected" : ""}`}
              style={css(r)}
              role="button"
              aria-label={`Image ${img.index + 1}, ${img.width} × ${img.height} pixels`}
              aria-pressed={sel}
              onPointerDown={(e) => {
                e.stopPropagation();
                p.onSelectImage(p.page, img.index);
                ref.current!.setPointerCapture(e.pointerId);
                const s = pt(e);
                setDrag({ kind: "move", index: img.index, start: s, cur: s, moved: false });
              }}
            >
              {sel &&
                [0, 1, 2, 3].map((c) => (
                  <span
                    key={c}
                    className={`annot-handle annot-handle--${c}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      ref.current!.setPointerCapture(e.pointerId);
                      setDrag({ kind: "resize", index: img.index, corner: (c + (p.rotation / 90) * 3) % 4, rect: img.rect, cur: img.rect });
                    }}
                  />
                ))}
            </div>
          );
        })}

      {p.tool === "link" &&
        p.links.map((l, i) => (
          <div
            key={i}
            className={`edit-link ${p.selectedLink === i ? "edit-link--selected" : ""}`}
            style={css(l.rect)}
            role="button"
            aria-label={l.uri ? `Link to ${l.uri}` : `Link to page ${(l.dest?.page ?? 0) + 1}`}
            title={l.uri ?? `Go to page ${(l.dest?.page ?? 0) + 1}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              p.onSelectLink(p.page, i);
            }}
          />
        ))}

      {adding && (
        <NewTextEditor
          at={adding}
          css={(() => {
            const fs = p.textStyle.size;
            const r = css([adding[0], adding[1] - fs * 0.85, adding[0] + 300, adding[1] + fs * 0.4]);
            return r;
          })()}
          scale={p.scale}
          style={p.textStyle}
          onDone={(t) => {
            setAdding(null);
            if (t.trim()) p.onAddText(p.page, [adding[0], adding[1] + p.textStyle.size * 0.1], t);
          }}
        />
      )}

      {drag?.kind === "area" && <div className={`area-box area-box--${p.tool}`} style={css(norm([drag.start[0], drag.start[1], drag.cur[0], drag.cur[1]]))} />}
    </div>
  );
});

function LineEditor({ line, style, scale, onDone, onCancel }: { line: TextLine; style: React.CSSProperties; scale: number; onDone: (t: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(ref.current?.value ?? line.text);
  };
  const family = line.mono ? FONT.mono : line.serif ? FONT.serif : FONT.sans;
  return (
    <input
      ref={ref}
      className="line-editor"
      aria-label="Edit line"
      defaultValue={line.text}
      style={{
        ...style,
        minWidth: (style.width as number) + 40,
        fontSize: line.size * scale,
        fontFamily: family,
        fontWeight: line.bold ? 700 : 400,
        fontStyle: line.italic ? "italic" : "normal",
        color: `rgb(${line.color.map((c) => Math.round(c * 255)).join(",")})`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish();
        else if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}

function NewTextEditor({ css, scale, style, onDone }: { at: Point; css: React.CSSProperties; scale: number; style: Props["textStyle"]; onDone: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => ref.current?.focus(), []);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(ref.current?.value ?? "");
  };
  return (
    <textarea
      ref={ref}
      className="line-editor line-editor--new"
      aria-label="New text"
      placeholder="Type text"
      style={{ ...css, height: "auto", fontSize: style.size * scale, lineHeight: 1.2, fontFamily: FONT[style.family], fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? "italic" : "normal", color: style.color }}
      rows={1}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={finish}
      onInput={(e) => {
        const t = e.currentTarget;
        t.rows = Math.max(1, t.value.split("\n").length);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          done.current = true;
          onDone("");
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish();
      }}
    />
  );
}

function norm([x0, y0, x1, y1]: Rect): Rect {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}
