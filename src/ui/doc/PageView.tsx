import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CancelledError, engine } from "../../core/client";
import type { LinkInfo, PageSize, Rect, ViewRotation } from "../../core/types";
import { rectToView, rotatedSize } from "../geometry";
import { PREVIEW_PRIORITY, type DocData } from "./docData";
import { previewScale } from "./pageCache";

/** Keep page bitmaps under this many device pixels; beyond it, a viewport-sized detail tile adds sharpness. */
const MAX_BASE_PIXELS = 12_000_000;
const MAX_BASE_DIM = 8192;

/** The scale a page's whole-page bitmap is drawn at: its on-screen size in device pixels, capped. */
export function baseScaleFor(size: PageSize, rotation: ViewRotation, scale: number, dpr: number): number {
  const view = rotatedSize(size, rotation);
  return Math.min(scale * dpr, Math.sqrt(MAX_BASE_PIXELS / (view.width * view.height)), MAX_BASE_DIM / Math.max(view.width, view.height));
}

export interface PageOverlay {
  /** Search hit rectangles in page space; `current` marks the active hit. */
  hits: { rect: Rect; current: boolean }[];
  selection: Rect[];
}

interface Props {
  data: DocData;
  index: number;
  size: PageSize;
  rotation: ViewRotation;
  /** CSS pixels per PDF point. */
  scale: number;
  dpr: number;
  /** Render priority; lower renders first. */
  priority: number;
  /** Visible part of the page in CSS px relative to the page box, or null when off-screen. */
  visible: Rect | null;
  renderVersion: number;
  overlay: PageOverlay;
  showLinks: boolean;
  onLink: (link: LinkInfo) => void;
  style: React.CSSProperties;
  children?: React.ReactNode;
}

export const PageView = memo(function PageView(props: Props) {
  const { data, index, size, rotation, scale, dpr, priority, visible, renderVersion, overlay, showLinks, onLink, style } = props;
  const baseRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);
  const rendered = useRef<string | null>(null);
  const [detail, setDetail] = useState<Rect | null>(null);
  const [links, setLinks] = useState<LinkInfo[]>([]);

  const view = rotatedSize(size, rotation);
  const target = scale * dpr;
  const baseScale = baseScaleFor(size, rotation, scale, dpr);
  const needsDetail = baseScale < target * 0.98;

  // Base bitmap of the whole page. While zooming, the previous bitmap stays visible (stretched). A page coming into
  // view shows a recently drawn copy at once if there is one; otherwise a small preview first, then the sharp bitmap.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const canvas = baseRef.current!;
    const key = `${baseScale.toFixed(4)}|${rotation}|${renderVersion}`;
    if (rendered.current === key) return;
    const draw = (bitmap: ImageBitmap, state: "true" | "preview") => {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      canvas.dataset.rendered = state;
    };
    const content = `${rotation}|${renderVersion}`;
    const cached = data.bitmaps.sharp.get(data.bitmaps.sharpKey(index, baseScale, rotation, renderVersion));
    if (cached) {
      draw(cached, "true");
      rendered.current = key;
      shown.current = content;
      return;
    }
    const ctrl = new AbortController();
    let sharp = false;
    // Nothing of this content on the canvas yet (new page, edit or rotation): a preview stands in meanwhile.
    if (shown.current !== content && baseScale > previewScale(view.width, view.height) * 1.5) {
      data
        .pageBitmap("preview", index, view, baseScale, rotation, renderVersion, PREVIEW_PRIORITY + priority, ctrl.signal)
        .then((b) => {
          if (sharp) return;
          draw(b, "preview");
          shown.current = content;
        })
        .catch(() => {});
    }
    const delay = rendered.current === null ? 0 : 120;
    const timer = setTimeout(() => {
      data
        .pageBitmap("sharp", index, view, baseScale, rotation, renderVersion, priority, ctrl.signal)
        .then((b) => {
          sharp = true;
          draw(b, "true");
          rendered.current = key;
          shown.current = content;
        })
        .catch((err) => {
          if (!(err instanceof CancelledError)) canvas.dataset.rendered = "error";
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // priority is deliberately excluded: re-prioritising shouldn't restart a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseScale, rotation, renderVersion, data, index]);

  // Detail tile: only the visible window, at full resolution, when the base bitmap had to be capped.
  const visibleKey = visible && needsDetail ? visible.map((v) => Math.round(v / 64)).join(",") : null;
  useEffect(() => {
    if (!visible || !needsDetail) {
      setDetail(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      // Expand a little so small scrolls don't uncover blurry edges.
      const m = 128;
      const region: Rect = [
        Math.max(0, (visible[0] - m) * dpr),
        Math.max(0, (visible[1] - m) * dpr),
        Math.min(view.width * target, (visible[2] + m) * dpr),
        Math.min(view.height * target, (visible[3] + m) * dpr),
      ];
      engine()
        .render({ docId: data.docId, pageIndex: index, scale: target, rotation, region }, -1, ctrl.signal)
        .then(({ bitmap }) => {
          const c = detailRef.current;
          if (!c) return bitmap.close();
          c.width = bitmap.width;
          c.height = bitmap.height;
          c.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
          setDetail(region.map((v) => v / dpr) as Rect);
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, target, rotation, renderVersion, needsDetail]);

  useEffect(() => {
    let alive = true;
    data.pageLinks(index).then((l) => alive && setLinks(l), () => {});
    return () => {
      alive = false;
    };
  }, [data, index, renderVersion]);

  const toCss = (r: Rect) => {
    const [x0, y0, x1, y1] = rectToView(r, size, rotation, scale);
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  };

  const linkEls = useMemo(
    () =>
      showLinks
        ? links.map((link, i) => (
            <a
              key={i}
              className="page__link"
              href={link.uri ?? `#page=${(link.dest?.page ?? 0) + 1}`}
              title={link.uri ?? (link.dest ? `Go to page ${link.dest.page + 1}` : undefined)}
              style={toCss(link.rect)}
              onClick={(e) => {
                e.preventDefault();
                onLink(link);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            />
          ))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [links, showLinks, scale, rotation, onLink],
  );

  return (
    <div className="page" data-index={index} role="img" aria-label={`Page ${index + 1}`} style={style}>
      <canvas ref={baseRef} className="page__canvas" />
      <canvas
        ref={detailRef}
        className="page__detail"
        hidden={!detail}
        style={detail ? { left: detail[0], top: detail[1], width: detail[2] - detail[0], height: detail[3] - detail[1] } : undefined}
      />
      <div className="page__overlay">
        {overlay.hits.map((h, i) => (
          <div key={`h${i}`} className={h.current ? "hit hit--current" : "hit"} style={toCss(h.rect)} />
        ))}
        {overlay.selection.map((r, i) => (
          <div key={`s${i}`} className="selection" style={toCss(r)} />
        ))}
        {linkEls}
      </div>
      {props.children}
    </div>
  );
});
