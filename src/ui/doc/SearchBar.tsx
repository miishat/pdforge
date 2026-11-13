import { ChevronDown20Regular, ChevronUp20Regular, Dismiss20Regular, TextCaseTitle20Regular, TextWholeWord20Regular } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import type { SearchOptions } from "../../core/types";
import type { SearchState } from "./useSearch";

interface Props {
  state: SearchState;
  pageCount: number;
  focusToken: number;
  initialQuery?: string;
  onRun: (query: string, opts: SearchOptions) => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}

export function SearchBar({ state, pageCount, focusToken, initialQuery, onRun, onStep, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery ?? state.query);
  const opts = state.opts;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusToken]);

  useEffect(() => {
    if (initialQuery !== undefined) {
      setQuery(initialQuery);
      onRun(initialQuery, opts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  // Search as you type, after a short pause.
  useEffect(() => {
    if (query === state.query) return;
    const t = setTimeout(() => onRun(query, opts), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const toggle = (key: keyof SearchOptions) => onRun(query, { ...opts, [key]: !opts[key] });

  let status = "";
  if (state.error) status = state.error;
  else if (state.query && state.status !== "idle") {
    if (state.hits.length) status = `${((state.current ?? 0) + 1).toLocaleString()} of ${state.hits.length.toLocaleString()}${state.truncated ? "+" : ""}`;
    else if (state.status === "searching") status = "Searching…";
    else status = "No results";
    if (state.status === "searching" && pageCount > 50) status += ` · page ${state.searched} of ${pageCount}`;
  }

  return (
    <div className="searchbar" role="search">
      <input
        ref={input}
        className={`searchbar__input ${state.error ? "field--invalid" : ""}`}
        aria-label="Find in document"
        placeholder="Find in document"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (query !== state.query) onRun(query, opts);
            else onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="searchbar__options">
        <button className="icon-button icon-button--sm" aria-label="Match case" title="Match case" aria-pressed={opts.caseSensitive} onClick={() => toggle("caseSensitive")}>
          <TextCaseTitle20Regular />
        </button>
        <button className="icon-button icon-button--sm" aria-label="Whole words" title="Whole words" aria-pressed={opts.wholeWord} onClick={() => toggle("wholeWord")}>
          <TextWholeWord20Regular />
        </button>
        <button className="icon-button icon-button--sm searchbar__regex" aria-label="Regular expression" title="Regular expression" aria-pressed={opts.regex} onClick={() => toggle("regex")}>
          .*
        </button>
      </div>
      <span className="searchbar__status" role="status" aria-live="polite">
        {status}
      </span>
      <button className="icon-button icon-button--sm" aria-label="Previous result" title="Previous result (Shift+Enter)" disabled={!state.hits.length} onClick={() => onStep(-1)}>
        <ChevronUp20Regular />
      </button>
      <button className="icon-button icon-button--sm" aria-label="Next result" title="Next result (Enter)" disabled={!state.hits.length} onClick={() => onStep(1)}>
        <ChevronDown20Regular />
      </button>
      <button className="icon-button icon-button--sm" aria-label="Close search" title="Close (Esc)" onClick={onClose}>
        <Dismiss20Regular />
      </button>
    </div>
  );
}
