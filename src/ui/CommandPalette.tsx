import { Search20Regular } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { COMMANDS, displayCombo, matchScore, type CommandDef, type Keymap } from "./commands";
import { load, save } from "./settings";

const RECENT_KEY = "palette.recent";

/** Ctrl+K: every action, searchable, with its shortcut. Recently used commands come first. */
export function CommandPalette({ available, keymap, onRun, onClose }: { available: (id: string) => boolean; keymap: Keymap; onRun: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const recent = useMemo(() => load<string[]>(RECENT_KEY, []), []);

  useEffect(() => {
    const d = dialog.current!;
    if (!d.open) d.showModal();
    input.current?.focus();
    const cancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener("cancel", cancel);
    return () => d.removeEventListener("cancel", cancel);
  }, [onClose]);

  const results = useMemo(() => {
    const avail = COMMANDS.filter((c) => available(c.id));
    if (!query.trim()) {
      const rec = recent.map((id) => avail.find((c) => c.id === id)).filter(Boolean) as CommandDef[];
      return [...rec, ...avail.filter((c) => !recent.includes(c.id))];
    }
    return avail
      .map((c) => ({ c, s: matchScore(c, query) + (recent.includes(c.id) ? 1 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [query, available, recent]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (c: CommandDef | undefined) => {
    if (!c) return;
    save(RECENT_KEY, [c.id, ...recent.filter((id) => id !== c.id)].slice(0, 8));
    onClose();
    // After the palette closes, so dialogs the command opens get focus.
    setTimeout(() => onRun(c.id), 0);
  };

  return (
    <dialog ref={dialog} className="palette" aria-label="Command palette">
      <div className="palette__search">
        <Search20Regular />
        <input
          ref={input}
          className="palette__input"
          placeholder="Type a command"
          aria-label="Command"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(results[index]);
            }
          }}
        />
      </div>
      <ul ref={list} id="palette-list" className="palette__list" role="listbox" aria-label="Commands">
        {results.map((c, i) => (
          <li
            key={c.id}
            id={`palette-${c.id}`}
            data-index={i}
            role="option"
            aria-selected={i === index}
            className="palette__item"
            onMouseMove={() => setIndex(i)}
            onClick={() => run(c)}
          >
            <span className="palette__category">{c.category}</span>
            <span className="palette__label">{c.label}</span>
            {(keymap[c.id] ?? []).slice(0, 1).map((k) => (
              <kbd key={k}>{displayCombo(k)}</kbd>
            ))}
          </li>
        ))}
        {!results.length && <li className="palette__empty">No matching commands</li>}
      </ul>
    </dialog>
  );
}
