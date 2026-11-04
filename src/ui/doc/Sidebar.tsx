import {
  ArrowDownload20Regular,
  Attach20Regular,
  Bookmark20Regular,
  Certificate20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  CommentMultiple20Regular,
  Layer20Regular,
  Search20Regular,
  SlideMultiple20Regular,
} from "@fluentui/react-icons";
import { memo, useEffect, useRef, useState } from "react";
import { CancelledError, engine } from "../../core/client";
import type { AttachmentInfo, DocInfo, LayerInfo, OutlineNode } from "../../core/types";
import type { Dest } from "./Canvas";
import type { SearchState } from "./useSearch";

export type Panel = "thumbnails" | "outline" | "search" | "comments" | "attachments" | "layers" | "signatures";

interface Props {
  info: DocInfo;
  panel: Panel;
  onPanel: (p: Panel) => void;
  currentPage: number;
  outline: OutlineNode[];
  attachments: AttachmentInfo[];
  layers: LayerInfo[];
  search: SearchState;
  renderVersion: number;
  onGo: (dest: Dest) => void;
  onSelectHit: (i: number) => void;
  onSaveAttachment: (name: string) => void;
  onToggleLayer: (index: number, visible: boolean) => void;
  comments: React.ReactNode;
  signatures: React.ReactNode | null;
}

const PANELS: { id: Panel; label: string; icon: JSX.Element }[] = [
  { id: "thumbnails", label: "Pages", icon: <SlideMultiple20Regular /> },
  { id: "outline", label: "Bookmarks", icon: <Bookmark20Regular /> },
  { id: "search", label: "Search results", icon: <Search20Regular /> },
  { id: "comments", label: "Comments", icon: <CommentMultiple20Regular /> },
  { id: "attachments", label: "Attachments", icon: <Attach20Regular /> },
  { id: "layers", label: "Layers", icon: <Layer20Regular /> },
  { id: "signatures", label: "Signatures", icon: <Certificate20Regular /> },
];

export function Sidebar(props: Props) {
  const { panel, onPanel } = props;
  // Only offer panels that have something in them (search appears once there's a query).
  const available = PANELS.filter(
    (p) =>
      (p.id !== "outline" || props.outline.length > 0) &&
      (p.id !== "attachments" || props.attachments.length > 0) &&
      (p.id !== "layers" || props.layers.length > 0) &&
      (p.id !== "search" || !!props.search.query) &&
      (p.id !== "signatures" || props.signatures !== null),
  );
  const shown = available.some((p) => p.id === panel) ? panel : "thumbnails";
  const title = PANELS.find((p) => p.id === shown)!.label;
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <nav className="sidebar__rail" role="tablist" aria-label="Sidebar panels" aria-orientation="vertical">
        {available.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={shown === p.id}
            aria-label={p.label}
            title={p.label}
            className="icon-button"
            onClick={() => onPanel(p.id)}
          >
            {p.icon}
          </button>
        ))}
      </nav>
      <section className="sidebar__panel" role="tabpanel" aria-label={title}>
        <h2 className="sidebar__title">{title}</h2>
        <div className="sidebar__content">
          {shown === "thumbnails" && <Thumbnails {...props} />}
          {shown === "outline" && <OutlineTree nodes={props.outline} onGo={props.onGo} depth={0} />}
          {shown === "search" && <SearchResults search={props.search} onSelect={props.onSelectHit} labels={props.info.labels} />}
          {shown === "comments" && props.comments}
          {shown === "signatures" && props.signatures}
          {shown === "attachments" && <Attachments items={props.attachments} onSave={props.onSaveAttachment} />}
          {shown === "layers" && <Layers items={props.layers} onToggle={props.onToggleLayer} />}
        </div>
      </section>
    </aside>
  );
}

const THUMB_W = 112;

function Thumbnails({ info, currentPage, onGo, renderVersion }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    const root = listRef.current!.closest(".sidebar__content")!;
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
    listRef.current!.querySelectorAll<HTMLElement>(".thumb").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [info]);

  // Keep the current page's thumbnail in view as the reader scrolls.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`.thumb[data-index="${currentPage}"]`)?.scrollIntoView({ block: "nearest" });
  }, [currentPage]);

  return (
    <div ref={listRef} className="thumbs">
      {info.pages.map((size, i) => (
        <button
          key={i}
          className="thumb"
          data-index={i}
          aria-current={i === currentPage ? "page" : undefined}
          aria-label={`Page ${info.labels?.[i] ?? i + 1}`}
          onClick={() => onGo({ page: i })}
        >
          <Thumb docId={info.docId} index={i} width={THUMB_W} pageWidth={size.width} aspect={size.height / size.width} active={visible.has(i)} priority={100 + Math.abs(i - currentPage)} version={renderVersion} />
          <span className="thumb__label">{info.labels?.[i] ?? i + 1}</span>
        </button>
      ))}
    </div>
  );
}

const Thumb = memo(function Thumb(p: {
  docId: number;
  index: number;
  width: number;
  pageWidth: number;
  aspect: number;
  active: boolean;
  priority: number;
  version: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const done = useRef<number | null>(null);
  useEffect(() => {
    if (!p.active || done.current === p.version) return;
    const ctrl = new AbortController();
    // Sharp at the current display scaling: `width` CSS px wide.
    const scale = (p.width * (window.devicePixelRatio || 1)) / p.pageWidth;
    engine()
      .render({ docId: p.docId, pageIndex: p.index, scale, rotation: 0 }, p.priority, ctrl.signal)
      .then(({ bitmap }) => {
        const c = ref.current;
        if (!c) return bitmap.close();
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        c.dataset.rendered = "true";
        done.current = p.version;
      })
      .catch((e) => {
        if (!(e instanceof CancelledError)) done.current = null;
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.active, p.version]);
  return <canvas ref={ref} className="thumb__canvas" style={{ width: p.width, height: p.width * p.aspect }} />;
});

function OutlineTree({ nodes, onGo, depth }: { nodes: OutlineNode[]; onGo: (d: Dest) => void; depth: number }) {
  return (
    <ul className="tree" role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Bookmarks" : undefined}>
      {nodes.map((n, i) => (
        <OutlineItem key={i} node={n} onGo={onGo} depth={depth} />
      ))}
    </ul>
  );
}

function OutlineItem({ node, onGo, depth }: { node: OutlineNode; onGo: (d: Dest) => void; depth: number }) {
  const [open, setOpen] = useState(node.open);
  const hasKids = node.children.length > 0;
  return (
    <li role="treeitem" aria-expanded={hasKids ? open : undefined}>
      <div className="tree__row" style={{ paddingLeft: depth * 14 }}>
        {hasKids ? (
          <button className="tree__toggle" aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          </button>
        ) : (
          <span className="tree__toggle" />
        )}
        <button
          className="tree__label"
          disabled={!node.dest && !node.uri}
          title={node.title}
          onClick={() => node.dest && onGo({ page: node.dest.page, y: node.dest.y })}
        >
          {node.title}
        </button>
      </div>
      {hasKids && open && <OutlineTree nodes={node.children} onGo={onGo} depth={depth + 1} />}
    </li>
  );
}

function SearchResults({ search, onSelect, labels }: { search: SearchState; onSelect: (i: number) => void; labels: string[] | null }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [search.current]);
  if (!search.hits.length) return <p className="sidebar__empty">{search.status === "searching" ? "Searching…" : "No results."}</p>;
  let lastPage = -1;
  return (
    <ol ref={listRef} className="results">
      {search.hits.map((h, i) => {
        const header = h.page !== lastPage;
        lastPage = h.page;
        return (
          <li key={i}>
            {header && <div className="results__page">Page {labels?.[h.page] ?? h.page + 1}</div>}
            <button className="results__item" aria-current={i === search.current} onClick={() => onSelect(i)}>
              {h.before}
              <mark>{h.match}</mark>
              {h.after}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Attachments({ items, onSave }: { items: AttachmentInfo[]; onSave: (name: string) => void }) {
  return (
    <ul className="files">
      {items.map((a) => (
        <li key={a.name} className="file">
          <span className="file__name" title={a.name}>
            {a.name}
          </span>
          <span className="file__meta">{a.size != null ? formatBytes(a.size) : a.mimeType ?? ""}</span>
          <button className="icon-button icon-button--sm" aria-label={`Save ${a.name}`} title="Save a copy…" onClick={() => onSave(a.name)}>
            <ArrowDownload20Regular />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Layers({ items, onToggle }: { items: LayerInfo[]; onToggle: (i: number, v: boolean) => void }) {
  return (
    <ul className="layers">
      {items.map((l) => (
        <li key={l.index}>
          <label className="check">
            <input type="checkbox" checked={l.visible} onChange={(e) => onToggle(l.index, e.target.checked)} />
            <span>{l.name}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
