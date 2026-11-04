import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { caretAt, charRect, lineAt, wordAt } from "../../core/textlayer";
import type { DocInfo, LinkInfo, Rect, SearchHit, ViewRotation } from "../../core/types";
import { rotatedSize, toPage, toView } from "../geometry";
import { GAP, layoutPages, pagesInRange, rowAt, type Layout, type LayoutMode } from "../layout";
import { useDocData, type DocData } from "./docData";
import { MARKUP_TOOLS, type AnnotTool } from "./tools";
import { PageView, type PageOverlay } from "./PageView";
import { selectionRects, type TextSelection } from "./selection";

export type Tool = "select" | "hand" | "snapshot" | "marquee" | AnnotTool;
export type ReadingMode = "normal" | "night" | "sepia";

export interface Dest {
  page: number;
  /** Page-space y to bring to the top of the view; null shows the top of the page. */
  y?: number | null;
  /** Page-space rect to bring into view (centred if it isn't visible). */
  rect?: Rect;
}

export interface CanvasHandle {
  scrollTo(dest: Dest, opts?: { center?: boolean }): void;
  /** Where the view is now, for history. */
  here(): Dest;
  /** Zoom changes keep this client point fixed (Ctrl+wheel); otherwise the top-left of the view stays put. */
  setZoomFocus(point: { x: number; y: number } | null): void;
  /** Applied after the next layout change instead of the usual anchoring (used by marquee zoom). */
  setPendingScroll(dest: Dest): void;
  viewportSize(): { width: number; height: number };
  element(): HTMLDivElement | null;
}

interface Props {
  info: DocInfo;
  data: DocData;
  active: boolean;
  scale: number;
  rotation: ViewRotation;
  mode: LayoutMode;
  tool: Tool;
  readingMode: ReadingMode;
  renderVersion: number;
  hits: SearchHit[];
  currentHit: number | null;
  selection: TextSelection | null;
  onSelection: (sel: TextSelection | null) => void;
  onViewport: (size: { width: number; height: number }) => void;
  onCurrentPage: (page: number) => void;
  onLink: (link: LinkInfo) => void;
  onAreaDone: (tool: "snapshot" | "marquee", page: number, rect: Rect) => void;
  onContextMenu: (e: React.MouseEvent, page: number | null) => void;
  onZoomStep: (dir: 1 | -1) => void;
  /** Annotation and form layers drawn over each mounted page. */
  renderOverlay?: (page: number, scale: number) => React.ReactNode;
  /** With a text markup tool, called when a drag-selection finishes. */
  onMarkup?: () => void;
  linksEnabled: boolean;
}

type Drag =
  | { kind: "select"; anchor: { page: number; offset: number } }
  | { kind: "pan"; x: number; y: number; left: number; top: number }
  | { kind: "area"; tool: "snapshot" | "marquee"; page: number; x0: number; y0: number; x1: number; y1: number };

const OVERSCAN = 1; // viewports above and below to keep rendered

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(props, ref) {
  const { info, data, active, scale, rotation, mode, tool, readingMode, renderVersion, hits, currentHit, selection } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [layersVersion, setLayersVersion] = useState(0);
  const zoomFocus = useRef<{ x: number; y: number } | null>(null);
  const pendingScroll = useRef<{ dest: Dest; center: boolean } | null>(null);
  const prevLayout = useRef<Layout | null>(null);
  const currentPageRef = useRef(0);
  const lastScroll = useRef({ left: 0, top: 0 });

  useDocData(data);
  const layout = useMemo(() => layoutPages(info.pages, rotation, mode, scale, viewport.width), [info, rotation, mode, scale, viewport.width]);

  // Viewport size and display scaling.
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => {
      const size = { width: el.clientWidth, height: el.clientHeight };
      setViewport(size);
      props.onViewport(size);
    });
    ro.observe(el);
    let mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDpr = () => {
      setDpr(window.devicePixelRatio || 1);
      mq.removeEventListener("change", onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener("change", onDpr);
    };
    mq.addEventListener("change", onDpr);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", onDpr);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const boxToScroll = useCallback(
    (l: Layout, dest: Dest, center: boolean) => {
      const el = scrollRef.current!;
      const box = l.boxes[Math.max(0, Math.min(dest.page, l.boxes.length - 1))];
      const size = info.pages[dest.page];
      const s = box.w / rotatedSize(size, rotation).width;
      if (dest.rect) {
        const a = toView([dest.rect[0], dest.rect[1]], size, rotation);
        const b = toView([dest.rect[2], dest.rect[3]], size, rotation);
        const x0 = box.x + Math.min(a[0], b[0]) * s;
        const y0 = box.y + Math.min(a[1], b[1]) * s;
        const x1 = box.x + Math.max(a[0], b[0]) * s;
        const y1 = box.y + Math.max(a[1], b[1]) * s;
        const visible = y0 >= el.scrollTop && y1 <= el.scrollTop + el.clientHeight && x0 >= el.scrollLeft && x1 <= el.scrollLeft + el.clientWidth;
        if (!visible || center) {
          el.scrollTop = (y0 + y1) / 2 - el.clientHeight / 2;
          if (x0 < el.scrollLeft || x1 > el.scrollLeft + el.clientWidth || center) el.scrollLeft = (x0 + x1) / 2 - el.clientWidth / 2;
        }
        return;
      }
      if (dest.y != null) {
        const v = toView([0, dest.y], size, rotation);
        el.scrollTop = box.y + v[1] * s - 8;
      } else {
        el.scrollTop = box.y - GAP / 2;
      }
    },
    [info, rotation],
  );

  // Keep the reader's place when the layout changes (zoom, rotation, layout mode, window resize).
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const prev = prevLayout.current;
    prevLayout.current = layout;
    if (pendingScroll.current) {
      const { dest, center } = pendingScroll.current;
      pendingScroll.current = null;
      boxToScroll(layout, dest, center);
      lastScroll.current = { left: el.scrollLeft, top: el.scrollTop };
      setScroll(lastScroll.current);
      return;
    }
    if (!prev || prev === layout || !prev.boxes.length) return;
    // Use the scroll position from before this render: the browser may already have clamped
    // el.scrollTop if the content just got shorter.
    const before = lastScroll.current;
    const rect = el.getBoundingClientRect();
    const focus = zoomFocus.current ?? { x: rect.left, y: rect.top };
    zoomFocus.current = null;
    const fx = focus.x - rect.left;
    const fy = focus.y - rect.top;
    // Find the page under the focus point in the previous layout.
    const y = before.top + fy;
    const row = prev.rows[rowAt(prev, y)];
    const page = row.find((i) => prev.boxes[i].x + prev.boxes[i].w >= before.left + fx) ?? row[0];
    const pb = prev.boxes[page];
    const nb = layout.boxes[page];
    const ry = (y - pb.y) / pb.h;
    const rx = (before.left + fx - pb.x) / pb.w;
    el.scrollTop = nb.y + ry * nb.h - fy;
    el.scrollLeft = nb.x + rx * nb.w - fx;
    lastScroll.current = { left: el.scrollLeft, top: el.scrollTop };
    setScroll(lastScroll.current);
  }, [layout, boxToScroll]);

  const updateCurrent = useCallback(() => {
    const el = scrollRef.current!;
    const probe = el.scrollTop + el.clientHeight / 3;
    const row = layout.rows[rowAt(layout, probe)] ?? [0];
    const page = row[0];
    if (page !== currentPageRef.current) {
      currentPageRef.current = page;
      props.onCurrentPage(page);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(updateCurrent, [updateCurrent]);

  const onScroll = () => {
    const el = scrollRef.current!;
    lastScroll.current = { left: el.scrollLeft, top: el.scrollTop };
    setScroll(lastScroll.current);
    updateCurrent();
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollTo(dest, opts) {
        boxToScroll(layout, dest, !!opts?.center);
        onScroll();
      },
      here() {
        const el = scrollRef.current!;
        const page = layout.rows[rowAt(layout, el.scrollTop + 1)]?.[0] ?? 0;
        const box = layout.boxes[page];
        const s = box.w / rotatedSize(info.pages[page], rotation).width;
        const pt = toPage([0, Math.max(0, (el.scrollTop + 8 - box.y) / s)], info.pages[page], rotation);
        return { page, y: rotation === 0 ? pt[1] : null };
      },
      setZoomFocus(p) {
        zoomFocus.current = p;
      },
      setPendingScroll(dest) {
        pendingScroll.current = { dest, center: true };
      },
      viewportSize: () => ({ width: scrollRef.current?.clientWidth ?? 0, height: scrollRef.current?.clientHeight ?? 0 }),
      element: () => scrollRef.current,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, boxToScroll, info, rotation],
  );

  // Space bar temporarily switches to the hand tool, as in Acrobat.
  useEffect(() => {
    if (!active) return;
    const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement)?.tagName ?? "");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !typing() && !e.ctrlKey) {
        setSpaceHeld(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [active]);

  // Which pages to mount, and what part of each is on screen.
  const pages = useMemo(() => {
    if (!active || !viewport.height) return [];
    const top = scroll.top - viewport.height * OVERSCAN;
    const bottom = scroll.top + viewport.height * (1 + OVERSCAN);
    return pagesInRange(layout, top, bottom);
  }, [active, layout, scroll.top, viewport.height]);

  // Prefetch text for visible pages so selection and cursor feedback are instant.
  useEffect(() => {
    for (const p of pages) data.textLayer(p).then(() => setLayersVersion((v) => v + 1), () => {});
  }, [pages, data]);

  /** Page under a client point, with the point converted to page space. */
  const hitPage = useCallback(
    (clientX: number, clientY: number, clamp = false): { page: number; pt: [number, number] } | null => {
      const c = contentRef.current!.getBoundingClientRect();
      const x = clientX - c.left;
      const y = clientY - c.top;
      let page = -1;
      const row = layout.rows[rowAt(layout, y)];
      if (!row) return null;
      for (const i of row) {
        const b = layout.boxes[i];
        if (x >= b.x - GAP / 2 && x <= b.x + b.w + GAP / 2) page = i;
      }
      if (page < 0) {
        if (!clamp) return null;
        page = row.reduce((best, i) => (Math.abs(layout.boxes[i].x - x) < Math.abs(layout.boxes[best].x - x) ? i : best), row[0]);
      }
      const b = layout.boxes[page];
      const s = b.w / rotatedSize(info.pages[page], rotation).width;
      let vx = (x - b.x) / s;
      let vy = (y - b.y) / s;
      if (clamp) {
        const v = rotatedSize(info.pages[page], rotation);
        vx = Math.max(0, Math.min(v.width, vx));
        vy = Math.max(0, Math.min(v.height, vy));
      }
      return { page, pt: toPage([vx, vy], info.pages[page], rotation) };
    },
    [layout, info, rotation],
  );

  const effectiveTool: Tool = spaceHeld ? "hand" : tool;
  const lastPress = useRef<{ t: number; x: number; y: number; n: number } | null>(null);

  const onPointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = scrollRef.current!;
    if (effectiveTool === "hand") {
      el.setPointerCapture(e.pointerId);
      setDrag({ kind: "pan", x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop });
      return;
    }
    const hit = hitPage(e.clientX, e.clientY);
    if (!hit) {
      props.onSelection(null);
      return;
    }
    if (effectiveTool !== "select" && !MARKUP_TOOLS.has(effectiveTool as AnnotTool) && effectiveTool !== "snapshot" && effectiveTool !== "marquee") {
      // Drawing tools are handled by the page's annotation layer.
      return;
    }
    if (effectiveTool === "snapshot" || effectiveTool === "marquee") {
      el.setPointerCapture(e.pointerId);
      const [x, y] = hit.pt;
      setDrag({ kind: "area", tool: effectiveTool, page: hit.page, x0: x, y0: y, x1: x, y1: y });
      return;
    }
    // Pointer events don't carry a click count, so count quick repeated presses ourselves.
    const now = performance.now();
    const last = lastPress.current;
    const repeat = last && now - last.t < 500 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 5;
    const clicks = repeat ? last.n + 1 : 1;
    lastPress.current = { t: now, x: e.clientX, y: e.clientY, n: clicks };
    el.setPointerCapture(e.pointerId);
    const layer = data.textLayerNow(hit.page) ?? (await data.textLayer(hit.page));
    const offset = caretAt(layer, hit.pt[0], hit.pt[1]);
    if (offset == null) {
      props.onSelection(null);
      return;
    }
    if (clicks === 2 || clicks >= 3) {
      const [s, en] = clicks === 2 ? wordAt(layer, offset) : lineAt(layer, offset);
      props.onSelection({ anchor: { page: hit.page, offset: s }, focus: { page: hit.page, offset: en } });
      return;
    }
    if (e.shiftKey && selection) {
      props.onSelection({ anchor: selection.anchor, focus: { page: hit.page, offset } });
    } else {
      props.onSelection({ anchor: { page: hit.page, offset }, focus: { page: hit.page, offset } });
    }
    setDrag({ kind: "select", anchor: e.shiftKey && selection ? selection.anchor : { page: hit.page, offset } });
  };

  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  const moveDrag = useCallback(
    (clientX: number, clientY: number) => {
      if (!drag) return;
      const el = scrollRef.current!;
      if (drag.kind === "pan") {
        el.scrollLeft = drag.left - (clientX - drag.x);
        el.scrollTop = drag.top - (clientY - drag.y);
        return;
      }
      const hit = hitPage(clientX, clientY, true);
      if (!hit) return;
      if (drag.kind === "area") {
        if (hit.page !== drag.page) return;
        setDrag({ ...drag, x1: hit.pt[0], y1: hit.pt[1] });
        return;
      }
      const layer = data.textLayerNow(hit.page);
      if (!layer) {
        void data.textLayer(hit.page);
        return;
      }
      const offset = caretAt(layer, hit.pt[0], hit.pt[1]);
      if (offset != null) props.onSelection({ anchor: drag.anchor, focus: { page: hit.page, offset } });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag, hitPage, data],
  );

  // Auto-scroll while dragging near the top or bottom edge.
  useEffect(() => {
    if (!drag || drag.kind === "pan") return;
    let raf = 0;
    const tick = () => {
      const p = lastPointer.current;
      const el = scrollRef.current;
      if (p && el) {
        const r = el.getBoundingClientRect();
        const edge = 32;
        const dy = p.y < r.top + edge ? -(r.top + edge - p.y) : p.y > r.bottom - edge ? p.y - (r.bottom - edge) : 0;
        if (dy) {
          el.scrollTop += Math.max(-30, Math.min(30, dy / 2));
          moveDrag(p.x, p.y);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [drag, moveDrag]);

  const onPointerMove = (e: React.PointerEvent) => {
    lastPointer.current = { x: e.clientX, y: e.clientY };
    if (drag) return moveDrag(e.clientX, e.clientY);
    if (effectiveTool !== "select" && !MARKUP_TOOLS.has(effectiveTool as AnnotTool)) return;
    // Text cursor over text, arrow elsewhere.
    const hit = hitPage(e.clientX, e.clientY);
    const layer = hit && data.textLayerNow(hit.page);
    const el = scrollRef.current!;
    const overText = !!layer && isOverText(layer, hit!.pt);
    el.dataset.cursor = overText ? "text" : "";
  };

  const onPointerUp = () => {
    if (drag?.kind === "select" && MARKUP_TOOLS.has(effectiveTool as AnnotTool)) {
      setDrag(null);
      props.onMarkup?.();
      return;
    }
    if (drag?.kind === "area") {
      const r: Rect = [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1)];
      if (r[2] - r[0] > 4 && r[3] - r[1] > 4) props.onAreaDone(drag.tool, drag.page, r);
    }
    setDrag(null);
  };

  const onWheel = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    const el = scrollRef.current!;
    const handler = (e: WheelEvent) => onWheel.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);
  onWheel.current = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomFocus.current = { x: e.clientX, y: e.clientY };
    props.onZoomStep(e.deltaY < 0 ? 1 : -1);
  };

  const overlays = useMemo(() => {
    const out = new Map<number, PageOverlay>();
    for (const p of pages) {
      const pageHits: PageOverlay["hits"] = [];
      hits.forEach((h, i) => {
        if (h.page === p) for (const rect of h.rects) pageHits.push({ rect, current: i === currentHit });
      });
      out.set(p, { hits: pageHits, selection: selectionRects(selection, p, data.textLayerNow(p)) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, hits, currentHit, selection, data, layersVersion]);

  const visibleRect = (i: number): Rect | null => {
    const b = layout.boxes[i];
    const x0 = Math.max(0, scroll.left - b.x);
    const y0 = Math.max(0, scroll.top - b.y);
    const x1 = Math.min(b.w, scroll.left + viewport.width - b.x);
    const y1 = Math.min(b.h, scroll.top + viewport.height - b.y);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  };

  const current = currentPageRef.current;
  const areaBox = (() => {
    if (drag?.kind !== "area") return null;
    const b = layout.boxes[drag.page];
    const size = info.pages[drag.page];
    const s = b.w / rotatedSize(size, rotation).width;
    const a = toView([drag.x0, drag.y0], size, rotation);
    const c = toView([drag.x1, drag.y1], size, rotation);
    return {
      left: b.x + Math.min(a[0], c[0]) * s,
      top: b.y + Math.min(a[1], c[1]) * s,
      width: Math.abs(c[0] - a[0]) * s,
      height: Math.abs(c[1] - a[1]) * s,
    };
  })();

  return (
    <div
      ref={scrollRef}
      className={`canvas-area canvas-area--${readingMode}`}
      data-tool={effectiveTool}
      data-dragging={drag?.kind === "pan" ? "true" : undefined}
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu(e, hitPage(e.clientX, e.clientY)?.page ?? null);
      }}
      tabIndex={0}
      aria-label="Document pages"
    >
      <div ref={contentRef} className="page-layer" style={{ width: layout.width, height: layout.height }}>
        {pages.map((i) => {
          const b = layout.boxes[i];
          return (
            <PageView
              key={i}
              data={data}
              index={i}
              size={info.pages[i]}
              rotation={rotation}
              scale={b.w / rotatedSize(info.pages[i], rotation).width}
              dpr={dpr}
              priority={Math.abs(i - current)}
              visible={visibleRect(i)}
              renderVersion={renderVersion * 10_000_000 + data.renderKey(i)}
              overlay={overlays.get(i) ?? { hits: [], selection: [] }}
              showLinks={props.linksEnabled && (effectiveTool === "select" || effectiveTool === "hand")}
              onLink={props.onLink}
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
            >
              {props.renderOverlay?.(i, b.w / rotatedSize(info.pages[i], rotation).width)}
            </PageView>
          );
        })}
        {areaBox && <div className={`area-box area-box--${drag?.kind === "area" ? drag.tool : ""}`} style={areaBox} />}
      </div>
    </div>
  );
});

function isOverText(layer: { text: string; quads: Float32Array; lines: Int32Array }, [x, y]: [number, number]): boolean {
  const pad = 2;
  for (let i = 0; i < layer.text.length; i++) {
    const r = charRect(layer, i);
    if (x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad) return true;
  }
  return false;
}
