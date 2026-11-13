import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../../core/client";
import { ensureTextIndex, stopTextIndex } from "./textIndex";
import { loadSavedText, saveText } from "./savedText";
import type { SearchHit, SearchOptions } from "../../core/types";

/**
 * The most hits one search collects; past that the count shows "+". Hits are small (page and character offsets;
 * their snippets are fetched only for the rows on screen), so even this many take a few MB.
 */
export const MAX_HITS = 50_000;
/** Hits in the first batch of a search (shown at once), and in each later one. */
const FIRST_BATCH_HITS = 500;
const BATCH_HITS = 20_000;

export interface SearchState {
  query: string;
  opts: SearchOptions;
  hits: SearchHit[];
  current: number | null;
  status: "idle" | "searching" | "done" | "error";
  /** Pages searched so far, for progress. */
  searched: number;
  error: string | null;
  truncated: boolean;
  /** How many hits lie before the page the search started from (they arrive last). */
  hitsBefore: number;
}

const initial: SearchState = {
  query: "",
  opts: { caseSensitive: false, wholeWord: false, regex: false },
  hits: [],
  current: null,
  status: "idle",
  searched: 0,
  error: null,
  truncated: false,
  hitsBefore: 0,
};

/** Incremental document search: runs in page batches so results appear quickly and a new query cancels the old one. */
export function useSearch(docId: number, pageCount: number, startPage: () => number) {
  const [state, setState] = useState<SearchState>(initial);
  const token = useRef(0);

  const run = useCallback(
    (query: string, opts: SearchOptions) => {
      const my = ++token.current;
      if (!query.trim()) {
        setState({ ...initial, query, opts });
        return;
      }
      setState((s) => ({ ...s, query, opts, hits: [], current: null, status: "searching", searched: 0, error: null, truncated: false }));
      const from = Math.max(0, Math.min(pageCount - 1, startPage()));
      (async () => {
        // On a large document the first search reads every page's text; helper workers do that in parallel.
        // Text saved from an earlier session comes first; it makes the helpers unnecessary.
        await loadSavedText(docId, pageCount).catch(() => false);
        if (token.current !== my) return;
        const index = await ensureTextIndex(docId, pageCount, from).catch(() => null);
        // Once every page has been read, save the text so the next session's first search is instant too.
        if (index) void index.finished.then(() => index.complete && saveText(docId, pageCount)).catch(() => {});
        // Search from the reader's page to the end, then wrap around, so nearby results come first.
        // `head` holds hits before the start page and `tail` the rest; the list shown is head + tail, in page order.
        const head: SearchHit[] = [];
        const tail: SearchHit[] = [];
        const segments: [number, number, SearchHit[]][] = [[from, pageCount, tail], [0, from, head]];
        let searched = 0;
        let lastPaint = 0;
        let picked = false;
        for (const [segFrom, segTo, into] of segments) {
          let p = segFrom;
          while (p < segTo) {
            if (token.current !== my) return;
            let r: { hits: SearchHit[]; next: number };
            try {
              const helping = !!index?.active;
              // Small first batch so the first result shows at once; then batches big enough to keep up, but small
              // enough that handing them over never holds up the screen.
              const batch = Math.min(MAX_HITS - head.length - tail.length, picked ? BATCH_HITS : FIRST_BATCH_HITS);
              r = await engine().call("find", docId, query, opts, p, segTo, batch, 60, !helping, false);
              if (helping && r.next === p) {
                // The helpers haven't read this page yet.
                await index!.changed();
                continue;
              }
            } catch (err) {
              if (token.current === my) setState((s) => ({ ...s, status: "error", error: err instanceof Error ? err.message : String(err) }));
              return;
            }
            if (token.current !== my) return;
            const added = r.hits;
            searched += r.next - p;
            p = r.next;
            // One at a time: spreading a batch of several hundred thousand hits would overflow the call stack.
            for (const h of added) {
              if (head.length + tail.length >= MAX_HITS) break;
              into.push(h);
            }
            const truncated = head.length + tail.length >= MAX_HITS;
            const done = truncated || (into === head && p >= segTo) || (into === tail && p >= segTo && from === 0);
            const now = performance.now();
            // Repaint at most a few times a second; long result lists are costly to redraw.
            if (done || now - lastPaint > 250 || (!picked && added.length)) {
              lastPaint = now;
              const headLen = head.length;
              setState((s) => {
                let current = s.current;
                if (!picked || current == null) current = tail.length ? headLen : headLen ? 0 : null;
                // Hits found before the start page are inserted in front, so keep pointing at the same hit.
                else current += headLen - s.hitsBefore;
                return {
                  ...s,
                  hits: head.concat(tail),
                  hitsBefore: headLen,
                  searched: Math.min(pageCount, searched),
                  current,
                  status: done ? "done" : "searching",
                  truncated,
                };
              });
              if (tail.length || head.length) picked = true;
            }
            if (truncated) return;
            if (done) {
              if (!index) void saveText(docId, pageCount).catch(() => {});
              return;
            }
            // Yield so the UI stays responsive between batches.
            await new Promise((res) => setTimeout(res, 0));
          }
        }
      })();
    },
    [docId, pageCount, startPage],
  );

  const step = useCallback((dir: 1 | -1) => {
    setState((s) => {
      if (!s.hits.length) return s;
      const cur = s.current ?? (dir > 0 ? -1 : 0);
      return { ...s, current: (cur + dir + s.hits.length) % s.hits.length };
    });
  }, []);

  const select = useCallback((i: number) => setState((s) => ({ ...s, current: i })), []);

  const clear = useCallback(() => {
    token.current++;
    setState((s) => ({ ...initial, opts: s.opts }));
  }, []);

  useEffect(
    () => () => {
      token.current++;
      stopTextIndex(docId);
    },
    [docId],
  );

  return { state, run, step, select, clear };
}
