import { Add16Regular, ChevronDown16Regular, ChevronRight16Regular, MoreHorizontal16Regular } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OutlineEdit } from "../../core/content";
import type { OutlineNode } from "../../core/types";
import { Menu } from "../components/Menu";
import type { Dest } from "./Canvas";

type Node = OutlineEdit & { open?: boolean; y?: number | null };

export function toEdit(nodes: OutlineNode[]): Node[] {
  return nodes.map((n) => ({ title: n.title, page: n.dest?.page ?? 0, y: n.dest?.y ?? null, open: n.open, children: toEdit(n.children) }));
}

function nodeAt(tree: Node[], k: string): Node | undefined {
  let list = tree;
  let node: Node | undefined;
  for (const i of k.split(".").map(Number)) {
    node = list[i];
    if (!node) return undefined;
    list = node.children as Node[];
  }
  return node;
}

/** The bookmark for the section the reader is in: the last one, in reading order, that starts on or before the page. */
export function currentPath(tree: Node[], page: number): Path | null {
  let found: Path | null = null;
  const walk = (nodes: Node[], parent: Path) =>
    nodes.forEach((n, i) => {
      const path = [...parent, i];
      if (n.page <= page) found = path;
      walk(n.children as Node[], path);
    });
  walk(tree, []);
  return found;
}

type Path = number[];

function at(tree: Node[], path: Path): { list: Node[]; index: number } {
  let list = tree;
  for (let i = 0; i < path.length - 1; i++) list = list[path[i]].children as Node[];
  return { list, index: path[path.length - 1] };
}

function clone(tree: Node[]): Node[] {
  return tree.map((n) => ({ ...n, children: clone(n.children as Node[]) }));
}

/** Pure tree edits used by the bookmark panel. */
export const outlineOps = {
  rename(tree: Node[], path: Path, title: string) {
    const t = clone(tree);
    const { list, index } = at(t, path);
    list[index].title = title;
    return t;
  },
  setPage(tree: Node[], path: Path, page: number) {
    const t = clone(tree);
    const { list, index } = at(t, path);
    list[index].page = page;
    return t;
  },
  remove(tree: Node[], path: Path) {
    const t = clone(tree);
    const { list, index } = at(t, path);
    list.splice(index, 1);
    return t;
  },
  move(tree: Node[], path: Path, d: -1 | 1) {
    const t = clone(tree);
    const { list, index } = at(t, path);
    const j = index + d;
    if (j < 0 || j >= list.length) return tree;
    [list[index], list[j]] = [list[j], list[index]];
    return t;
  },
  indent(tree: Node[], path: Path) {
    const t = clone(tree);
    const { list, index } = at(t, path);
    if (index === 0) return tree;
    const [node] = list.splice(index, 1);
    list[index - 1].children.push(node);
    (list[index - 1] as Node).open = true;
    return t;
  },
  outdent(tree: Node[], path: Path) {
    if (path.length < 2) return tree;
    const t = clone(tree);
    const { list, index } = at(t, path);
    const [node] = list.splice(index, 1);
    const parent = at(t, path.slice(0, -1));
    parent.list.splice(parent.index + 1, 0, node);
    return t;
  },
  /** Adds after the given bookmark (or at the end), returning the new tree and the new path. */
  add(tree: Node[], after: Path | null, node: Node): [Node[], Path] {
    const t = clone(tree);
    if (!after) {
      t.push(node);
      return [t, [t.length - 1]];
    }
    const { list, index } = at(t, after);
    list.splice(index + 1, 0, node);
    return [t, [...after.slice(0, -1), index + 1]];
  },
};

export function BookmarkEditor({ outline, currentPage, labels, onGo, onChange, suggestTitle }: {
  outline: OutlineNode[];
  currentPage: number;
  labels: string[] | null;
  onGo: (d: Dest) => void;
  onChange: (nodes: OutlineEdit[]) => void;
  suggestTitle: () => Promise<string | null>;
}) {
  const tree = useMemo(() => toEdit(outline), [outline]);
  const [selected, setSelected] = useState<Path | null>(null);
  const [renaming, setRenaming] = useState<Path | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: Path } | null>(null);
  // Which bookmarks are expanded, by path. Kept here so navigating (which re-renders the tree) never collapses it.
  const [expanded, setExpanded] = useState<Map<string, boolean>>(() => new Map());
  const same = (a: Path | null, b: Path) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
  const key = (path: Path) => path.join(".");
  const isOpen = (n: Node, path: Path) => expanded.get(key(path)) ?? n.open ?? false;
  // Bookmarks opened only to reveal the current section; they close again when the reader moves on.
  const auto = useRef(new Set<string>());
  const toggle = (path: Path, open: boolean) => {
    auto.current.delete(key(path));
    setExpanded((m) => new Map(m).set(key(path), open));
  };

  // Show where the reader is: highlight the current section and open the bookmarks around it.
  const current = useMemo(() => currentPath(tree, currentPage), [tree, currentPage]);
  const currentKey = current ? key(current) : null;
  useEffect(() => {
    const ancestors = new Set<string>();
    for (let i = 1; i < (current?.length ?? 0); i++) ancestors.add(key(current!.slice(0, i)));
    setExpanded((m) => {
      let next: Map<string, boolean> | null = null;
      for (const k of auto.current) {
        if (ancestors.has(k)) continue;
        (next ??= new Map(m)).set(k, false);
        auto.current.delete(k);
      }
      for (const k of ancestors) {
        if ((next ?? m).get(k) === true) continue;
        // Open by the document or the reader already? Then it isn't ours to close later.
        const node = nodeAt(tree, k);
        if (!(next ?? m).has(k) && node?.open) continue;
        (next ??= new Map(m)).set(k, true);
        auto.current.add(k);
      }
      return next ?? m;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".tree__row--current")?.scrollIntoView({ block: "nearest" });
  }, [currentKey, expanded]);

  const add = async () => {
    const title = (await suggestTitle()) ?? `Page ${labels?.[currentPage] ?? currentPage + 1}`;
    const [t, path] = outlineOps.add(tree, selected, { title, page: currentPage, children: [] });
    onChange(t);
    setSelected(path);
    setRenaming(path);
  };

  const render = (nodes: Node[], parent: Path, depth: number) => (
    <ul className="tree" role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Bookmarks" : undefined}>
      {nodes.map((n, i) => item(n, [...parent, i], depth))}
    </ul>
  );

  // A plain function, not a component: a component defined in here would be new on every render and lose its state.
  const item = (n: Node, path: Path, depth: number) => {
    const open = isOpen(n, path);
    const kids = n.children.length > 0;
    const sel = same(selected, path);
    const here = key(path) === currentKey;
    return (
      <li key={key(path)} role="treeitem" aria-expanded={kids ? open : undefined} aria-selected={sel}>
        <div className={`tree__row ${sel ? "tree__row--selected" : ""} ${here ? "tree__row--current" : ""}`} style={{ paddingLeft: depth * 14 }}>
          {kids ? (
            <button className="tree__toggle" aria-label={open ? "Collapse" : "Expand"} onClick={() => toggle(path, !open)}>
              {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
            </button>
          ) : (
            <span className="tree__toggle" />
          )}
          {same(renaming, path) ? (
            <input
              className="field field--compact tree__rename"
              aria-label="Bookmark name"
              defaultValue={n.title}
              autoFocus
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                setRenaming(null);
                if (e.target.value.trim() && e.target.value !== n.title) onChange(outlineOps.rename(tree, path, e.target.value.trim()));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              className="tree__label"
              title={`${n.title} (page ${labels?.[n.page] ?? n.page + 1})`}
              aria-current={here ? "location" : undefined}
              onClick={() => {
                setSelected(path);
                onGo({ page: n.page, y: n.y ?? null });
              }}
              onDoubleClick={() => setRenaming(path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(path);
                setMenu({ x: e.clientX, y: e.clientY, path });
              }}
            >
              {n.title}
            </button>
          )}
          <button
            className="icon-button icon-button--xs tree__more"
            aria-label={`Actions for ${n.title}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSelected(path);
              setMenu({ x: r.right, y: r.bottom + 2, path });
            }}
          >
            <MoreHorizontal16Regular />
          </button>
        </div>
        {kids && open && render(n.children as Node[], path, depth + 1)}
      </li>
    );
  };

  return (
    <div className="bookmarks" ref={listRef}>
      <button
        className="button button--small bookmarks__add"
        aria-label={`Add bookmark for page ${labels?.[currentPage] ?? currentPage + 1}`}
        title={`Add a bookmark for page ${labels?.[currentPage] ?? currentPage + 1}`}
        onClick={() => void add()}
      >
        <Add16Regular />
        <span className="bookmarks__add-text">Add bookmark</span>
        <span className="bookmarks__add-page">p. {labels?.[currentPage] ?? currentPage + 1}</span>
      </button>
      {tree.length ? render(tree, [], 0) : <p className="sidebar__empty">No bookmarks yet. Bookmarks let readers jump to sections.</p>}
      {menu && (
        <Menu
          label="Bookmark"
          at={{ x: menu.x, y: menu.y, alignRight: true }}
          onClose={() => setMenu(null)}
          entries={[
            { label: "Rename", onSelect: () => setRenaming(menu.path) },
            { label: `Point to page ${currentPage + 1}`, onSelect: () => onChange(outlineOps.setPage(tree, menu.path, currentPage)) },
            { kind: "separator" },
            { label: "Move up", onSelect: () => onChange(outlineOps.move(tree, menu.path, -1)) },
            { label: "Move down", onSelect: () => onChange(outlineOps.move(tree, menu.path, 1)) },
            { label: "Indent", onSelect: () => onChange(outlineOps.indent(tree, menu.path)) },
            { label: "Outdent", onSelect: () => onChange(outlineOps.outdent(tree, menu.path)) },
            { kind: "separator" },
            { label: "Delete", onSelect: () => (onChange(outlineOps.remove(tree, menu.path)), setSelected(null)) },
          ]}
        />
      )}
    </div>
  );
}
