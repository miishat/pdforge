import { ArrowLeft20Regular, ArrowSync20Regular, Dismiss20Regular, DocumentSearch20Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { Change, TextComparison } from "../../core/compare";
import type { DocInfo, Rect } from "../../core/types";
import { pickPdfs } from "../../platform";

export interface CompareSide {
  docId: number;
  name: string;
}

interface Opened extends CompareSide {
  info: DocInfo;
  /** Opened just for comparing (closed again afterwards). */
  own: boolean;
}

interface VisualChange {
  page: number;
  rect: Rect;
}

type Item = { kind: "text"; change: Change; index: number } | { kind: "visual"; page: number; rects: Rect[]; index: number };

/**
 * Two documents side by side: words that changed are highlighted (red: removed, green: added),
 * non-text differences are outlined, and every change is listed. Scrolling is synchronised.
 */
export function CompareView({ a, others, onClose }: { a: CompareSide; others: CompareSide[]; onClose: () => void }) {
  const [left, setLeft] = useState<Opened | null>(null);
  const [right, setRight] = useState<Opened | null>(null);
  const [result, setResult] = useState<(TextComparison & { aPages: number; bPages: number }) | null>(null);
  const [visual, setVisual] = useState<VisualChange[]>([]);
  const [visualDone, setVisualDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "text" | "visual">("all");
  const [current, setCurrent] = useState<number | null>(null);
  const leftCol = useRef<HTMLDivElement>(null);
  const rightCol = useRef<HTMLDivElement>(null);
  const owned = useRef<number[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    engine().call("info", a.docId).then((info) => setLeft({ ...a, info, own: false }), (e) => setError(String(e?.message ?? e)));
    return () => {
      for (const id of owned.current) void engine().call("close", id);
    };
  }, [a]);

  const chooseOpen = async (side: CompareSide) => {
    try {
      const info = await engine().call("info", side.docId);
      setRight({ ...side, info, own: false });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };
  const chooseFile = async () => {
    const [f] = await pickPdfs();
    if (!f) return;
    try {
      const r = await engine().call("open", f.bytes.slice());
      if (r.status !== "ok") {
        void engine().call("close", r.docId);
        return setError(`${f.name} is password-protected. Open it in a tab first, then compare with it.`);
      }
      owned.current.push(r.info.docId);
      setRight({ docId: r.info.docId, name: f.name, info: r.info, own: true });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  // Text comparison, then page-by-page visual comparison in the background.
  useEffect(() => {
    if (!left || !right) return;
    let cancelled = false;
    setResult(null);
    setVisual([]);
    setVisualDone(false);
    setError(null);
    (async () => {
      try {
        const r = await engine().call("compareText", left.docId, right.docId);
        if (cancelled) return;
        setResult(r);
        const pages = Math.min(r.aPages, r.bPages);
        const found: VisualChange[] = [];
        for (let p = 0; p < pages && !cancelled; p++) {
          const regions = await engine().call("compareVisual", left.docId, p, right.docId, p, 50);
          // Text changes already explain most visual differences; keep the rest.
          const text = r.changes.flatMap((c) => [...c.aRects, ...c.bRects]).filter((x) => x.page === p).map((x) => x.rect);
          for (const rect of regions) if (!text.some((t) => overlaps(t, rect))) found.push({ page: p, rect });
          if (!cancelled) setVisual([...found]);
        }
        if (!cancelled) setVisualDone(true);
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [left, right]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    if (result) result.changes.forEach((change) => out.push({ kind: "text", change, index: 0 }));
    const byPage = new Map<number, Rect[]>();
    for (const v of visual) byPage.set(v.page, [...(byPage.get(v.page) ?? []), v.rect]);
    for (const [page, rects] of byPage) out.push({ kind: "visual", page, rects, index: 0 });
    out.sort((x, y) => pageOf(x) - pageOf(y));
    return out.map((it, index) => ({ ...it, index }));
  }, [result, visual]);
  const shown = items.filter((i) => filter === "all" || i.kind === filter);

  // Synchronised scrolling between the two columns (proportional within the page under the top edge).
  const syncing = useRef(false);
  const sync = useCallback((from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    const pos = positionOf(from);
    if (!pos) return;
    syncing.current = true;
    scrollToPosition(to, pos.page, pos.frac);
    requestAnimationFrame(() => (syncing.current = false));
  }, []);

  const go = (it: Item) => {
    setCurrent(it.index);
    const lp = it.kind === "text" ? it.change.aRects[0]?.page ?? it.change.aPage : it.page;
    const rp = it.kind === "text" ? it.change.bRects[0]?.page ?? it.change.bPage : it.page;
    const ly = it.kind === "text" ? it.change.aRects[0]?.rect[1] : it.rects[0][1];
    const ry = it.kind === "text" ? it.change.bRects[0]?.rect[1] : it.rects[0][1];
    syncing.current = true;
    if (left) scrollToPage(leftCol.current, lp, ly, left.info);
    if (right) scrollToPage(rightCol.current, rp, ry, right.info);
    setTimeout(() => (syncing.current = false), 50);
  };

  const counts = {
    text: items.filter((i) => i.kind === "text").length,
    visual: items.filter((i) => i.kind === "visual").length,
  };

  return (
    <div className="compare" role="region" aria-label="Compare documents">
      <header className="compare__header">
        <button className="icon-button" aria-label="Close comparison" title="Close (Esc)" onClick={onClose}>
          <ArrowLeft20Regular />
        </button>
        <h1 className="compare__title">Compare</h1>
        <span className="compare__name compare__name--a" title={a.name}>{a.name}</span>
        <ArrowSync20Regular aria-hidden="true" />
        {right ? (
          <span className="compare__name compare__name--b" title={right.name}>
            {right.name}
            <button className="icon-button icon-button--xs" aria-label="Choose a different document" onClick={() => (setRight(null), setResult(null))}><Dismiss20Regular /></button>
          </span>
        ) : (
          <span className="muted">Choose a document to compare with</span>
        )}
      </header>
      {!right ? (
        <div className="compare__pick">
          <DocumentSearch20Regular />
          <p>Compare <strong>{a.name}</strong> with:</p>
          <div className="compare__choices">
            {others.map((o) => (
              <button key={o.docId} className="button" onClick={() => void chooseOpen(o)}>{o.name}</button>
            ))}
            <button className="button button--primary" onClick={() => void chooseFile()}>Choose a PDF…</button>
          </div>
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="compare__body">
          <div className="compare__cols">
            {left && <Column colRef={leftCol} doc={left} side="a" items={items} current={current} onScroll={() => sync(leftCol.current, rightCol.current)} />}
            {right && <Column colRef={rightCol} doc={right} side="b" items={items} current={current} onScroll={() => sync(rightCol.current, leftCol.current)} />}
          </div>
          <aside className="compare__panel" aria-label="Changes">
            <div className="compare__summary">
              {!result ? (
                "Comparing…"
              ) : items.length === 0 && visualDone ? (
                "No differences found."
              ) : (
                <>
                  {counts.text} text change{counts.text === 1 ? "" : "s"}
                  {counts.visual ? `, ${counts.visual} page${counts.visual === 1 ? "" : "s"} with other changes` : ""}
                  {!visualDone && " · checking pages…"}
                </>
              )}
              {result && result.aPages !== result.bPages && <div className="muted">{result.aPages} pages vs {result.bPages} pages.</div>}
              {result?.coarse && <div className="muted">The documents differ a lot, so they were compared page by page.</div>}
            </div>
            <div className="segmented-tabs" role="tablist" aria-label="Show">
              {(["all", "text", "visual"] as const).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className="segmented-tabs__tab" onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "text" ? "Text" : "Other"}
                </button>
              ))}
            </div>
            <ol className="change-list">
              {shown.map((it) => (
                <li key={it.index}>
                  <button className={`change ${current === it.index ? "change--current" : ""}`} onClick={() => go(it)}>
                    <span className="change__where">p. {pageOf(it) + 1}</span>
                    {it.kind === "text" ? (
                      <span className="change__text">
                        {it.change.before && <del>{clip(it.change.before)}</del>}
                        {it.change.before && it.change.after && " → "}
                        {it.change.after && <ins>{clip(it.change.after)}</ins>}
                      </span>
                    ) : (
                      <span className="change__text muted">Images or drawings differ ({it.rects.length} area{it.rects.length === 1 ? "" : "s"})</span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
            {error && <p className="error-text" role="alert">{error}</p>}
          </aside>
        </div>
      )}
    </div>
  );
}

const pageOf = (it: Item) => (it.kind === "text" ? it.change.aRects[0]?.page ?? it.change.aPage : it.page);
const clip = (s: string) => (s.length > 120 ? s.slice(0, 117) + "…" : s);
const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function positionOf(col: HTMLDivElement): { page: number; frac: number } | null {
  const pages = col.querySelectorAll<HTMLElement>(".compare-page");
  const top = col.scrollTop;
  for (const p of pages) {
    if (p.offsetTop + p.offsetHeight > top) return { page: Number(p.dataset.page), frac: Math.max(0, (top - p.offsetTop) / p.offsetHeight) };
  }
  return null;
}

function scrollToPosition(col: HTMLDivElement, page: number, frac: number) {
  const el = col.querySelector<HTMLElement>(`.compare-page[data-page="${page}"]`);
  if (el) col.scrollTop = el.offsetTop + frac * el.offsetHeight;
}

function scrollToPage(col: HTMLDivElement | null, page: number, y: number | undefined, info: DocInfo) {
  if (!col) return;
  const el = col.querySelector<HTMLElement>(`.compare-page[data-page="${page}"]`);
  if (!el) return;
  const h = info.pages[page]?.height ?? 792;
  const off = y != null ? (y / h) * el.offsetHeight : 0;
  col.scrollTo({ top: Math.max(0, el.offsetTop + off - col.clientHeight / 3) });
}

function Column({ colRef: ref, doc, side, items, current, onScroll }: { colRef: React.RefObject<HTMLDivElement>; doc: Opened; side: "a" | "b"; items: Item[]; current: number | null; onScroll: () => void }) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 48));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  const marks = useMemo(() => {
    const m = new Map<number, { rect: Rect; cls: string; index: number }[]>();
    const add = (page: number, rect: Rect, cls: string, index: number) => m.set(page, [...(m.get(page) ?? []), { rect, cls, index }]);
    for (const it of items) {
      if (it.kind === "text") {
        const rects = side === "a" ? it.change.aRects : it.change.bRects;
        for (const r of rects) add(r.page, r.rect, side === "a" ? (it.change.kind === "replace" ? "mark--changed" : "mark--removed") : it.change.kind === "replace" ? "mark--changed" : "mark--added", it.index);
      } else for (const r of it.rects) add(it.page, r, "mark--visual", it.index);
    }
    return m;
  }, [items, side]);
  return (
    <div ref={ref} className="compare__col" onScroll={onScroll} aria-label={side === "a" ? "First document" : "Second document"}>
      {width > 0 &&
        doc.info.pages.map((p, i) => (
          <ComparePage key={i} docId={doc.docId} page={i} size={p} width={Math.min(width, 900)} marks={marks.get(i) ?? []} current={current} />
        ))}
    </div>
  );
}

function ComparePage({ docId, page, size, width, marks, current }: { docId: number; page: number; size: { width: number; height: number }; width: number; marks: { rect: Rect; cls: string; index: number }[]; current: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const s = width / size.width;
  const height = size.height * s;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const ctrl = new AbortController();
    const dpr = window.devicePixelRatio || 1;
    engine()
      .render({ docId, pageIndex: page, scale: s * dpr, rotation: 0 }, page, ctrl.signal)
      .then(({ bitmap, width: w, height: h }) => {
        const c = canvasRef.current;
        if (!c) return bitmap.close();
        c.width = w;
        c.height = h;
        c.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
      }, () => {});
    return () => ctrl.abort();
  }, [visible, docId, page, s]);
  return (
    <div ref={ref} className="compare-page" data-page={page} style={{ width, height }}>
      <canvas ref={canvasRef} className="compare-page__canvas" style={{ width, height }} aria-label={`Page ${page + 1}`} />
      {marks.map((m, i) => (
        <span
          key={i}
          className={`mark ${m.cls} ${current === m.index ? "mark--current" : ""}`}
          style={{ left: m.rect[0] * s - 1, top: m.rect[1] * s - 1, width: (m.rect[2] - m.rect[0]) * s + 2, height: (m.rect[3] - m.rect[1]) * s + 2 }}
        />
      ))}
      <span className="compare-page__num">{page + 1}</span>
    </div>
  );
}
