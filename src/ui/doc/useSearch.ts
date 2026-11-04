import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { SearchHit, SearchOptions } from "../../core/types";

const BATCH = 25;
const MAX_HITS = 5000;

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
      const from = startPage();
      (async () => {
        const all: SearchHit[] = [];
        let firstJump = true;
        for (let p = 0; p < pageCount; p += BATCH) {
          if (token.current !== my) return;
          let batch: SearchHit[];
          try {
            batch = await engine().call("search", docId, query, opts, p, p + BATCH, MAX_HITS - all.length);
          } catch (err) {
            if (token.current === my) setState((s) => ({ ...s, status: "error", error: err instanceof Error ? err.message : String(err) }));
            return;
          }
          if (token.current !== my) return;
          all.push(...batch);
          const truncated = all.length >= MAX_HITS;
          // Select the first hit at or after the page the reader is on, once it's known.
          let current: number | null = null;
          const idx = all.findIndex((h) => h.page >= from);
          if (idx >= 0) current = idx;
          else if (p + BATCH >= pageCount && all.length) current = 0;
          setState((s) => ({
            ...s,
            hits: [...all],
            searched: Math.min(pageCount, p + BATCH),
            current: firstJump || s.current == null ? current : s.current,
            status: truncated || p + BATCH >= pageCount ? "done" : "searching",
            truncated,
          }));
          if (current != null) firstJump = false;
          if (truncated) return;
          // Yield so the UI stays responsive between batches.
          await new Promise((r) => setTimeout(r, 0));
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

  useEffect(() => () => void token.current++, []);

  return { state, run, step, select, clear };
}
