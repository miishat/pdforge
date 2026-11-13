// The search results list. A search can find up to 50,000 hits, so only the rows near the visible part of the
// list exist, and the text shown around each hit is fetched from the engine for those rows only.
import { useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { HitSnippet, SearchHit } from "../../core/types";
import type { SearchState } from "./useSearch";

/** Row heights in px; keep in step with `.results__page` and `.results__item` in app.css. */
export const RESULT_HEADER_H = 32;
export const RESULT_ITEM_H = 44;
/** Rows kept beyond the visible part, above and below, so scrolling doesn't show empty rows. */
const OVERSCAN_PX = 400;

const keyOf = (h: SearchHit) => `${h.page}:${h.start}:${h.end}`;

/**
 * Where each hit's row sits: hit i is at `i * ITEM_H + headers[i] * HEADER_H`, where headers[i] counts the page
 * headings up to and including its own page's.
 */
export function resultLayout(hits: SearchHit[]): { headers: Int32Array; height: number } {
  const headers = new Int32Array(hits.length);
  let n = 0;
  for (let i = 0; i < hits.length; i++) {
    if (i === 0 || hits[i].page !== hits[i - 1].page) n++;
    headers[i] = n;
  }
  return { headers, height: hits.length * RESULT_ITEM_H + n * RESULT_HEADER_H };
}

const rowTop = (headers: Int32Array, i: number) => i * RESULT_ITEM_H + headers[i] * RESULT_HEADER_H;

/** The first hit whose row ends below `y`. */
export function hitAt(headers: Int32Array, y: number): number {
  let lo = 0;
  let hi = headers.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowTop(headers, mid) + RESULT_ITEM_H <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function SearchResults({ docId, search, onSelect, labels }: { docId: number; search: SearchState; onSelect: (i: number) => void; labels: string[] | null }) {
  const listRef = useRef<HTMLOListElement>(null);
  const { hits } = search;
  const layout = useMemo(() => resultLayout(hits), [hits]);
  const [range, setRange] = useState<[number, number]>([0, 0]);

  // Snippets fetched so far, for this query only.
  const snippets = useRef(new Map<string, HitSnippet | null>());
  const asked = useRef(new Set<string>());
  const [, setFetched] = useState(0);
  useEffect(() => {
    snippets.current = new Map();
    asked.current = new Set();
  }, [docId, search.query, search.opts]);

  // Which rows are near the visible part of the scrolling sidebar.
  useEffect(() => {
    const list = listRef.current;
    const root = list?.closest(".sidebar__content") as HTMLElement | null;
    if (!list || !root) return;
    const update = () => {
      const top = root.scrollTop - list.offsetTop;
      const from = hitAt(layout.headers, top - OVERSCAN_PX);
      const to = Math.min(hits.length, hitAt(layout.headers, top + root.clientHeight + OVERSCAN_PX) + 1);
      setRange((r) => (r[0] === from && r[1] === to ? r : [from, to]));
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(root);
    return () => {
      root.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [hits, layout]);

  // Keep the current hit's row in view (stepping with Enter or F3).
  useEffect(() => {
    const list = listRef.current;
    const root = list?.closest(".sidebar__content") as HTMLElement | null;
    const i = search.current;
    if (!list || !root || i == null || i >= hits.length) return;
    const top = list.offsetTop + rowTop(layout.headers, i);
    const header = i === 0 || hits[i - 1].page !== hits[i].page ? RESULT_HEADER_H : 0;
    if (top - header < root.scrollTop) root.scrollTop = top - header - 4;
    else if (top + RESULT_ITEM_H > root.scrollTop + root.clientHeight) root.scrollTop = top + RESULT_ITEM_H - root.clientHeight + 4;
    // Only when the current hit changes, not as more hits arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.current]);

  // Fetch the text around the hits on screen that don't have it yet.
  useEffect(() => {
    const want = hits.slice(range[0], range[1]).filter((h) => h.match === undefined && !asked.current.has(keyOf(h)));
    if (!want.length) return;
    for (const h of want) asked.current.add(keyOf(h));
    const map = snippets.current;
    engine()
      .call("hitSnippets", docId, want.map(({ page, start, end }) => ({ page, start, end })))
      .then(
        (got) => {
          if (snippets.current !== map) return;
          got.forEach((s, i) => map.set(keyOf(want[i]), s));
          setFetched((n) => n + 1);
        },
        () => {
          // Let them be asked for again later (e.g. the document was busy).
          for (const h of want) asked.current.delete(keyOf(h));
        },
      );
  }, [docId, hits, range]);

  if (!hits.length) return <p className="sidebar__empty">{search.status === "searching" ? "Searching…" : "No results."}</p>;

  const rows = [];
  for (let i = range[0]; i < range[1]; i++) {
    const h = hits[i];
    const top = rowTop(layout.headers, i);
    if (i === 0 || hits[i - 1].page !== h.page)
      rows.push(
        <li key={`p${h.page}`} className="results__page" style={{ top: top - RESULT_HEADER_H }} aria-hidden="true">
          Page {labels?.[h.page] ?? h.page + 1}
        </li>,
      );
    const s = h.match !== undefined ? (h as HitSnippet) : snippets.current.get(keyOf(h));
    rows.push(
      // Only some rows exist at a time, so tell screen readers where each sits in the whole list.
      <li key={i} className="results__row" style={{ top }} aria-setsize={hits.length} aria-posinset={i + 1}>
        <button className="results__item" aria-current={i === search.current} aria-label={s ? undefined : `Result ${i + 1}, page ${labels?.[h.page] ?? h.page + 1}`} onClick={() => onSelect(i)}>
          <span className="results__text">
            {s ? (
              <>
                {s.before}
                <mark>{s.match}</mark>
                {s.after}
              </>
            ) : s === null ? (
              // Fetched, but the page is gone (deleted since the search).
              "This page no longer exists."
            ) : (
              "\u00a0"
            )}
          </span>
        </button>
      </li>,
    );
  }
  return (
    <ol ref={listRef} className="results results--virtual" style={{ height: layout.height }}>
      {rows}
    </ol>
  );
}
