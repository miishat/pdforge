import { Delete16Regular, Filter16Regular } from "@fluentui/react-icons";
import { useMemo, useState } from "react";
import type { AnnotationInfo } from "../../core/types";
import { Menu, type MenuEntry } from "../components/Menu";
import { colorToHex } from "./tools";

export const ANNOT_LABELS: Record<string, string> = {
  Text: "Note", FreeText: "Text box", Highlight: "Highlight", Underline: "Underline", StrikeOut: "Strikethrough",
  Squiggly: "Squiggly underline", Ink: "Drawing", Square: "Rectangle", Circle: "Ellipse", Line: "Line",
  Polygon: "Polygon", PolyLine: "Polyline", Stamp: "Stamp", FileAttachment: "Attached file", Caret: "Insert text",
  Redact: "Redaction mark",
};

export const STATUSES = ["None", "Accepted", "Rejected", "Cancelled", "Completed"] as const;

interface Thread {
  root: AnnotationInfo;
  replies: AnnotationInfo[];
  status: string | null;
}

export function buildThreads(annots: AnnotationInfo[]): Thread[] {
  const byId = new Map(annots.map((a) => [a.id, a]));
  const children = new Map<number, AnnotationInfo[]>();
  for (const a of annots) {
    if (a.inReplyTo != null && byId.has(a.inReplyTo)) children.set(a.inReplyTo, [...(children.get(a.inReplyTo) ?? []), a]);
  }
  const collect = (id: number): AnnotationInfo[] => (children.get(id) ?? []).flatMap((c) => [c, ...collect(c.id)]);
  return annots
    .filter((a) => a.inReplyTo == null || !byId.has(a.inReplyTo))
    .map((root) => {
      const all = collect(root.id).sort((x, y) => (x.created ?? "").localeCompare(y.created ?? ""));
      const states = all.filter((r) => r.state);
      return { root, replies: all.filter((r) => !r.state), status: states.length ? states[states.length - 1].state : null };
    });
}

interface Props {
  annots: AnnotationInfo[] | null;
  labels: string[] | null;
  canEdit: boolean;
  selectedId: number | null;
  author: string;
  onGo: (a: AnnotationInfo) => void;
  onEditContents: (a: AnnotationInfo, text: string) => void;
  onReply: (a: AnnotationInfo, text: string) => void;
  onStatus: (a: AnnotationInfo, status: string) => void;
  onDelete: (a: AnnotationInfo) => void;
}

export function CommentsPanel(p: Props) {
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [authorFilter, setAuthorFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const threads = useMemo(() => buildThreads(p.annots ?? []), [p.annots]);
  const types = [...new Set(threads.map((t) => t.root.type))];
  const authors = [...new Set((p.annots ?? []).map((a) => a.author).filter(Boolean))];
  const shown = threads.filter(
    (t) =>
      (!typeFilter.size || typeFilter.has(t.root.type)) &&
      (!authorFilter.size || [t.root, ...t.replies].some((a) => authorFilter.has(a.author))) &&
      (!statusFilter || (t.status ?? "None") === statusFilter) &&
      (!query || [t.root, ...t.replies].some((a) => a.contents.toLowerCase().includes(query.toLowerCase()) || a.author.toLowerCase().includes(query.toLowerCase()))),
  );
  const filtered = typeFilter.size > 0 || authorFilter.size > 0 || !!statusFilter;

  if (!p.annots) return <p className="sidebar__empty">Loading comments…</p>;
  if (!threads.length) return <p className="sidebar__empty">No comments yet. Switch to Comment mode to add some.</p>;

  const toggle = (set: Set<string>, v: string, fn: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    fn(n);
  };
  const filterEntries: MenuEntry[] = [
    { kind: "heading", label: "Type" },
    ...types.map((t) => ({ label: ANNOT_LABELS[t] ?? t, checked: typeFilter.has(t), onSelect: () => toggle(typeFilter, t, setTypeFilter) })),
    ...(authors.length > 1
      ? [{ kind: "separator" } as MenuEntry, { kind: "heading", label: "Author" } as MenuEntry, ...authors.map((a) => ({ label: a, checked: authorFilter.has(a), onSelect: () => toggle(authorFilter, a, setAuthorFilter) }))]
      : []),
    { kind: "separator" },
    { kind: "heading", label: "Status" },
    ...STATUSES.map((s) => ({ label: s === "None" ? "No status" : s, checked: statusFilter === s, onSelect: () => setStatusFilter(statusFilter === s ? null : s) })),
    ...(filtered ? [{ kind: "separator" } as MenuEntry, { label: "Show all", onSelect: () => (setTypeFilter(new Set()), setAuthorFilter(new Set()), setStatusFilter(null)) }] : []),
  ];

  return (
    <div className="comments-panel">
      <div className="comments-panel__tools">
        <input className="field field--compact" placeholder="Search comments" aria-label="Search comments" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button
          className="icon-button icon-button--sm"
          aria-label="Filter comments"
          title="Filter"
          aria-pressed={filtered}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right, y: r.bottom + 4 });
          }}
        >
          <Filter16Regular />
        </button>
        {menu && <Menu label="Filter comments" at={{ ...menu, alignRight: true }} entries={filterEntries} onClose={() => setMenu(null)} />}
      </div>
      <p className="comments-panel__count">
        {shown.length === threads.length ? `${threads.length} comment${threads.length === 1 ? "" : "s"}` : `${shown.length} of ${threads.length} comments`}
      </p>
      <ul className="comments">
        {shown.map((t) => (
          <ThreadView key={t.root.id} t={t} {...p} />
        ))}
      </ul>
    </div>
  );
}

function ThreadView({ t, labels, canEdit, selectedId, onGo, onEditContents, onReply, onStatus, onDelete }: Props & { t: Thread }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const a = t.root;
  const swatch = colorToHex(a.type === "FreeText" ? null : a.color);
  return (
    <li className="thread" aria-current={a.id === selectedId || undefined}>
      <button className="comment" onClick={() => onGo(a)}>
        <span className="comment__meta">
          <span className="comment__type">
            {swatch && <span className="comment__swatch" style={{ background: swatch }} />}
            {ANNOT_LABELS[a.type] ?? a.type}
          </span>
          <span>Page {labels?.[a.page] ?? a.page + 1}</span>
        </span>
        <span className="comment__by">
          {a.author || "Unknown"}
          {a.modified ? ` · ${new Date(a.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}
        </span>
      </button>
      {canEdit ? (
        <EditableText value={a.contents} placeholder="Add a comment…" onCommit={(v) => onEditContents(a, v)} label={`Comment text for ${ANNOT_LABELS[a.type] ?? a.type}`} />
      ) : (
        a.contents && <p className="comment__text">{a.contents}</p>
      )}
      {t.replies.map((r) => (
        <div key={r.id} className="reply">
          <span className="comment__by">
            {r.author || "Unknown"}
            {r.modified ? ` · ${new Date(r.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}
          </span>
          {canEdit ? <EditableText value={r.contents} onCommit={(v) => onEditContents(r, v)} label="Reply text" /> : <p className="comment__text">{r.contents}</p>}
        </div>
      ))}
      <div className="thread__actions">
        {t.status && t.status !== "None" && <span className={`status-chip status-chip--${t.status.toLowerCase()}`}>{t.status}</span>}
        {canEdit && (
          <>
            <button className="link-button" onClick={() => setReplying((r) => !r)}>Reply</button>
            <select className="select select--inline" aria-label="Status" value={t.status ?? "None"} onChange={(e) => onStatus(a, e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "None" ? "No status" : s}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <button className="icon-button icon-button--sm" aria-label="Delete comment" title="Delete" onClick={() => onDelete(a)}>
              <Delete16Regular />
            </button>
          </>
        )}
      </div>
      {replying && (
        <form
          className="reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onReply(a, text.trim());
            setText("");
            setReplying(false);
          }}
        >
          <textarea className="field field--area" aria-label="Reply" placeholder="Write a reply" value={text} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.currentTarget.form as HTMLFormElement).requestSubmit()} />
          <div className="reply-form__actions">
            <button type="button" className="button button--small" onClick={() => setReplying(false)}>Cancel</button>
            <button type="submit" className="button button--small button--primary" disabled={!text.trim()}>Reply</button>
          </div>
        </form>
      )}
    </li>
  );
}

function EditableText({ value, onCommit, placeholder, label }: { value: string; onCommit: (v: string) => void; placeholder?: string; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea
      className="comment__edit"
      aria-label={label}
      placeholder={placeholder}
      rows={Math.min(6, Math.max(1, (draft ?? value).split("\n").length))}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(null);
          (e.target as HTMLElement).blur();
        }
      }}
    />
  );
}
