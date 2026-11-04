import { memo, useEffect, useRef, useState } from "react";
import { CancelledError, engine } from "../../core/client";
import type { DocInfo } from "../../core/types";
import { useDocData, type DocData } from "./docData";

interface Props {
  info: DocInfo;
  data: DocData;
  selected: Set<number>;
  onSelect: (s: Set<number>) => void;
  onMove: (pages: number[], to: number) => void;
  onOpen: (page: number) => void;
  onContextMenu: (e: React.MouseEvent, page: number) => void;
  size: number;
}

/** All pages as a grid: click/Ctrl/Shift to select, drag to reorder, double-click to open. */
export function OrganizeView({ info, data, selected, onSelect, onMove, onOpen, onContextMenu, size }: Props) {
  useDocData(data);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [visible, setVisible] = useState<Set<number>>(() => new Set());
  const gridRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number[] | null>(null);

  useEffect(() => {
    const root = gridRef.current!;
    const io = new IntersectionObserver(
      (entries) =>
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.index);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        }),
      { root, rootMargin: "400px 0px" },
    );
    root.querySelectorAll<HTMLElement>(".org-card").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [info]);

  const click = (i: number, e: React.MouseEvent | React.KeyboardEvent) => {
    if (e.shiftKey && anchor != null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      const s = new Set(e.ctrlKey || e.metaKey ? selected : []);
      for (let k = a; k <= b; k++) s.add(k);
      onSelect(s);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const s = new Set(selected);
      if (s.has(i)) s.delete(i);
      else s.add(i);
      onSelect(s);
    } else onSelect(new Set([i]));
    setAnchor(i);
  };

  const focusCard = (i: number) => gridRef.current?.querySelector<HTMLElement>(`.org-card[data-index="${i}"]`)?.focus();
  const columns = () => {
    const g = gridRef.current;
    if (!g) return 1;
    const first = g.querySelector<HTMLElement>(".org-card");
    return first ? Math.max(1, Math.floor(g.clientWidth / (first.offsetWidth + 16))) : 1;
  };

  return (
    <div
      ref={gridRef}
      className="org-grid"
      role="listbox"
      aria-label="Pages"
      aria-multiselectable="true"
      style={{ "--card": `${size}px` } as React.CSSProperties}
      onClick={(e) => e.target === e.currentTarget && onSelect(new Set())}
    >
      {info.pages.map((p, i) => {
        const before = drop === i;
        const after = drop === info.pageCount && i === info.pageCount - 1;
        return (
          <div
            key={i}
            className={`org-card ${selected.has(i) ? "org-card--selected" : ""} ${before ? "org-card--drop-before" : ""} ${after ? "org-card--drop-after" : ""}`}
            data-index={i}
            role="option"
            aria-selected={selected.has(i)}
            aria-label={`Page ${info.labels?.[i] ?? i + 1}`}
            tabIndex={0}
            draggable
            onClick={(e) => click(i, e)}
            onDoubleClick={() => onOpen(i)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!selected.has(i)) onSelect(new Set([i]));
              onContextMenu(e, i);
            }}
            onKeyDown={(e) => {
              const cols = columns();
              const go = (j: number) => {
                if (j < 0 || j >= info.pageCount) return;
                e.preventDefault();
                focusCard(j);
                if (e.shiftKey) click(j, e);
              };
              if (e.key === "ArrowRight") go(i + 1);
              else if (e.key === "ArrowLeft") go(i - 1);
              else if (e.key === "ArrowDown") go(i + cols);
              else if (e.key === "ArrowUp") go(i - cols);
              else if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                if (e.key === "Enter" && !e.ctrlKey) onOpen(i);
                else click(i, e);
              }
            }}
            onDragStart={(e) => {
              const pages = selected.has(i) ? [...selected].sort((a, b) => a - b) : [i];
              if (!selected.has(i)) onSelect(new Set([i]));
              dragging.current = pages;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", pages.join(","));
            }}
            onDragOver={(e) => {
              if (!dragging.current) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDrop(e.clientX > r.left + r.width / 2 ? i + 1 : i);
            }}
            onDragEnd={() => {
              dragging.current = null;
              setDrop(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const pages = dragging.current;
              dragging.current = null;
              const to = drop;
              setDrop(null);
              if (!pages || to == null) return;
              // Dropping right next to where the pages already are changes nothing.
              const contiguous = pages.every((p, k) => k === 0 || p === pages[k - 1] + 1);
              if (contiguous && to >= pages[0] && to <= pages[pages.length - 1] + 1) return;
              onMove(pages, to);
            }}
          >
            <Card data={data} index={i} width={size} pageW={p.width} pageH={p.height} active={visible.has(i)} renderKey={data.renderKey(i)} />
            <span className="org-card__label">{info.labels?.[i] ?? i + 1}</span>
          </div>
        );
      })}
    </div>
  );
}

const Card = memo(function Card(p: { data: DocData; index: number; width: number; pageW: number; pageH: number; active: boolean; renderKey: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const done = useRef<string | null>(null);
  const box = p.width - 16;
  const scale = Math.min(box / p.pageW, (box * 1.3) / p.pageH);
  const key = `${p.renderKey}|${scale.toFixed(3)}|${p.pageW}x${p.pageH}`;
  useEffect(() => {
    if (!p.active || done.current === key) return;
    const ctrl = new AbortController();
    engine()
      .render({ docId: p.data.docId, pageIndex: p.index, scale: scale * (window.devicePixelRatio || 1), rotation: 0 }, 200 + p.index, ctrl.signal)
      .then(({ bitmap }) => {
        const c = ref.current;
        if (!c) return bitmap.close();
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        c.dataset.rendered = "true";
        done.current = key;
      })
      .catch((e) => {
        if (!(e instanceof CancelledError)) done.current = null;
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.active, key]);
  return (
    <div className="org-card__thumb" style={{ height: box * 1.3 }}>
      <canvas ref={ref} style={{ width: p.pageW * scale, height: p.pageH * scale }} />
    </div>
  );
});
