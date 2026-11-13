import { isMac } from "../platform";
import { useMemo, useState } from "react";
import { COMMAND_BY_ID, COMMANDS, comboOf, conflicts, displayCombo, effectiveKeymap, RESERVED, VIM_KEYS, type Keymap } from "./commands";
import { Dialog } from "./components/Dialog";

/** Rebind any command's shortcut; switch vim-style navigation on or off. */
export function ShortcutsDialog({ overrides, vim, onChange, onVim, onClose }: { overrides: Keymap; vim: boolean; onChange: (o: Keymap) => void; onVim: (on: boolean) => void; onClose: () => void }) {
  const [filter, setFilter] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const keymap = useMemo(() => effectiveKeymap(overrides), [overrides]);
  const shown = COMMANDS.filter((c) => !filter || `${c.label} ${c.category}`.toLowerCase().includes(filter.toLowerCase()) || (keymap[c.id] ?? []).some((k) => k.toLowerCase().includes(filter.toLowerCase())));

  const record = (id: string, e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(null);
    const combo = comboOf(e.nativeEvent);
    if (!combo) return;
    if (RESERVED.has(combo)) return setMessage(`${displayCombo(combo)} is reserved by ${isMac ? "macOS" : "Windows"} or the app, so it can't be used.`);
    const clash = conflicts(keymap, combo, id);
    const next: Keymap = { ...overrides, [id]: [combo] };
    // A shortcut does one thing: take it away from the command that had it.
    for (const other of clash) next[other] = (keymap[other] ?? []).filter((k) => k !== combo);
    onChange(next);
    setRecording(null);
    setMessage(clash.length ? `${displayCombo(combo)} was used by "${COMMAND_BY_ID.get(clash[0])!.label}"; it now does "${COMMAND_BY_ID.get(id)!.label}".` : null);
  };

  return (
    <Dialog
      title="Keyboard shortcuts"
      width={620}
      onClose={onClose}
      footer={<><button className="button" style={{ marginRight: "auto" }} disabled={!Object.keys(overrides).length} onClick={() => (onChange({}), setMessage("All shortcuts are back to their defaults."))}>Reset all</button><button className="button button--primary" onClick={onClose}>Done</button></>}
    >
      <input className="field" placeholder="Filter by command or key" aria-label="Filter shortcuts" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {message && <p className="muted" role="status">{message}</p>}
      <div className="shortcut-table" role="table" aria-label="Shortcuts">
        {shown.map((c) => {
          const keys = keymap[c.id] ?? [];
          const changed = c.id in overrides;
          return (
            <div key={c.id} className="shortcut-row" role="row">
              <span role="cell" className="shortcut-row__label">{c.label}</span>
              <span role="cell" className="shortcut-row__keys">
                {recording === c.id ? (
                  <button className="shortcut-record" autoFocus onKeyDown={(e) => record(c.id, e)} onBlur={() => setRecording(null)}>Press keys…</button>
                ) : (
                  <button className="shortcut-keys" aria-label={`Change shortcut for ${c.label}`} title="Click, then press the new shortcut" onClick={() => (setRecording(c.id), setMessage(null))}>
                    {keys.length ? keys.map((k) => <kbd key={k}>{displayCombo(k)}</kbd>) : <span className="muted">None</span>}
                  </button>
                )}
                {changed && (
                  <button className="link-button" onClick={() => { const n = { ...overrides }; delete n[c.id]; onChange(n); }}>Default</button>
                )}
                {keys.length > 0 && recording !== c.id && (
                  <button className="link-button" aria-label={`Remove shortcut for ${c.label}`} onClick={() => onChange({ ...overrides, [c.id]: [] })}>Clear</button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <fieldset className="fieldset">
        <label className="check check--stack">
          <input type="checkbox" checked={vim} onChange={(e) => onVim(e.target.checked)} />
          <span>
            Vim-style navigation
            <span className="muted"> {VIM_KEYS.map((v) => `${v.key}: ${v.label.toLowerCase()}`).join(" · ")}. These keys then don't switch tools; use the toolbar or the palette.</span>
          </span>
        </label>
      </fieldset>
    </Dialog>
  );
}
