import {
  ArrowAutofitWidth20Regular,
  ChevronDown20Regular,
  ChevronUp20Regular,
  DocumentFit20Regular,
  ZoomIn20Regular,
  ZoomOut20Regular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DocInfo } from "../core/types";
import { PageView } from "./PageView";
import { AUTO_MAX, clampZoom, formatZoom, PT_TO_CSS, stepZoom, type ZoomMode } from "./zoom";

const GAP = 16; // px between pages
const PAD = 24; // px around the page column
const KEEP_MARGIN = "1200px 0px"; // pages within this distance keep their bitmap

interface Anchor {
  page: number;
  /** Fraction of the page height at the top of the viewport. */
  frac: number;
}

export function Viewer({ info }: { info: DocInfo }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [mode, setMode] = useState<ZoomMode>({ kind: "auto" });
  const [active, setActive] = useState<Set<number>>(() => new Set());
  const [currentPage, setCurrentPage] = useState(0);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const anchorRef = useRef<Anchor | null>(null);

  // Track viewport size and display scaling (moving between monitors changes DPR).
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setViewport({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    const mq = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener("resize", mq);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", mq);
    };
  }, []);

  const maxW = useMemo(() => Math.max(...info.pages.map((p) => p.width)), [info]);
  const firstH = info.pages[0]?.height ?? 792;

  const zoom = useMemo(() => {
    if (mode.kind === "custom") return mode.zoom;
    if (!viewport.width) return 1;
    const byWidth = (viewport.width - PAD * 2) / (maxW * PT_TO_CSS);
    if (mode.kind === "auto") return clampZoom(Math.min(byWidth, AUTO_MAX));
    if (mode.kind === "fit-width") return clampZoom(byWidth);
    const byHeight = (viewport.height - PAD * 2) / (firstH * PT_TO_CSS);
    return clampZoom(Math.min(byWidth, byHeight));
  }, [mode, viewport, maxW, firstH]);
  const cssScale = zoom * PT_TO_CSS;

  // Top offset of each page in the scroll content.
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = PAD;
    for (const p of info.pages) {
      out.push(y);
      y += p.height * cssScale + GAP;
    }
    return out;
  }, [info, cssScale]);

  const pageAt = useCallback(
    (y: number) => {
      let lo = 0;
      let hi = tops.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [tops],
  );

  // Before a zoom change, remember where we are; after layout, put it back.
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current!;
    const page = pageAt(el.scrollTop);
    const h = info.pages[page].height * cssScale;
    anchorRef.current = { page, frac: (el.scrollTop - tops[page]) / h };
  }, [pageAt, info, cssScale, tops]);

  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    const el = scrollRef.current!;
    el.scrollTop = tops[a.page] + a.frac * info.pages[a.page].height * cssScale;
  }, [tops, info, cssScale]);

  const setZoomMode = useCallback(
    (next: ZoomMode) => {
      captureAnchor();
      setMode(next);
    },
    [captureAnchor],
  );
  const zoomBy = useCallback((dir: 1 | -1) => setZoomMode({ kind: "custom", zoom: stepZoom(zoom, dir) }), [zoom, setZoomMode]);

  const goToPage = useCallback(
    (index: number) => {
      const i = Math.max(0, Math.min(info.pageCount - 1, index));
      scrollRef.current!.scrollTo({ top: tops[i] - PAD / 2 });
      setCurrentPage(i);
    },
    [info, tops],
  );

  // Which pages are close enough to the viewport to render.
  useEffect(() => {
    const root = scrollRef.current!;
    const io = new IntersectionObserver(
      (entries) => {
        setActive((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.index);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        });
      },
      { root, rootMargin: KEEP_MARGIN },
    );
    root.querySelectorAll<HTMLElement>(".page").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [info]);

  const onScroll = () => {
    const el = scrollRef.current!;
    setCurrentPage(pageAt(el.scrollTop + el.clientHeight / 3));
  };

  // Keyboard and Ctrl+wheel zoom. Shortcuts follow Acrobat so muscle memory carries over.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const handled = (() => {
        switch (e.key) {
          case "=":
          case "+":
            zoomBy(1);
            return true;
          case "-":
            zoomBy(-1);
            return true;
          case "0":
            setZoomMode({ kind: "fit-page" });
            return true;
          case "1":
            setZoomMode({ kind: "custom", zoom: 1 });
            return true;
          case "2":
            setZoomMode({ kind: "fit-width" });
            return true;
        }
        return false;
      })();
      if (handled) e.preventDefault();
    };
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("wheel", onWheel);
    };
  }, [zoomBy, setZoomMode]);

  return (
    <div className="viewer">
      <div className="toolbar" role="toolbar" aria-label="View">
        <div className="toolbar__group">
          <button className="icon-button" aria-label="Previous page" title="Previous page" disabled={currentPage === 0} onClick={() => goToPage(currentPage - 1)}>
            <ChevronUp20Regular />
          </button>
          <button className="icon-button" aria-label="Next page" title="Next page" disabled={currentPage >= info.pageCount - 1} onClick={() => goToPage(currentPage + 1)}>
            <ChevronDown20Regular />
          </button>
          <PageInput current={currentPage} count={info.pageCount} onGo={goToPage} />
        </div>
        <div className="toolbar__divider" />
        <div className="toolbar__group">
          <button className="icon-button" aria-label="Zoom out" title="Zoom out (Ctrl+−)" onClick={() => zoomBy(-1)}>
            <ZoomOut20Regular />
          </button>
          <output className="zoom-readout" aria-label="Zoom level">{formatZoom(zoom)}</output>
          <button className="icon-button" aria-label="Zoom in" title="Zoom in (Ctrl++)" onClick={() => zoomBy(1)}>
            <ZoomIn20Regular />
          </button>
          <button
            className="icon-button"
            aria-label="Fit width"
            title="Fit width (Ctrl+2)"
            aria-pressed={mode.kind === "fit-width"}
            onClick={() => setZoomMode({ kind: "fit-width" })}
          >
            <ArrowAutofitWidth20Regular />
          </button>
          <button
            className="icon-button"
            aria-label="Fit page"
            title="Fit page (Ctrl+0)"
            aria-pressed={mode.kind === "fit-page"}
            onClick={() => setZoomMode({ kind: "fit-page" })}
          >
            <DocumentFit20Regular />
          </button>
        </div>
      </div>
      <div className="canvas-area" ref={scrollRef} onScroll={onScroll} tabIndex={-1}>
        <div className="page-column" style={{ padding: PAD, gap: GAP }}>
          {info.pages.map((size, i) => (
            <PageView key={i} docId={info.docId} index={i} size={size} cssScale={cssScale} dpr={dpr} active={active.has(i)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PageInput({ current, count, onGo }: { current: number; count: number; onGo: (i: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="page-input">
      <input
        aria-label="Page number"
        inputMode="numeric"
        value={draft ?? String(current + 1)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft) {
            onGo(Number(draft) - 1);
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{ width: `${String(count).length + 1.5}ch` }}
      />
      <span className="page-input__total">of {count}</span>
    </label>
  );
}
