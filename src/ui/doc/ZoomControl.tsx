import { ChevronDown16Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { Menu } from "../components/Menu";
import { clampZoom, formatZoom, type ZoomMode } from "../zoom";

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** Editable zoom percentage with a preset menu. */
export function ZoomControl({ zoom, mode, onMode }: { zoom: number; mode: ZoomMode; onMode: (m: ZoomMode) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const commit = () => {
    const n = parseFloat((draft ?? "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) onMode({ kind: "custom", zoom: clampZoom(n / 100) });
    setDraft(null);
  };
  return (
    <div className="zoom-control">
      <input
        aria-label="Zoom level"
        className="zoom-control__input"
        value={draft ?? formatZoom(zoom)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <button
        className="zoom-control__menu"
        aria-label="Zoom presets"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <ChevronDown16Regular />
      </button>
      {menu && (
        <Menu
          label="Zoom presets"
          at={menu}
          onClose={() => setMenu(null)}
          entries={[
            { label: "Automatic", checked: mode.kind === "auto", onSelect: () => onMode({ kind: "auto" }) },
            { label: "Fit width", shortcut: "Ctrl+2", checked: mode.kind === "fit-width", onSelect: () => onMode({ kind: "fit-width" }) },
            { label: "Fit page", shortcut: "Ctrl+0", checked: mode.kind === "fit-page", onSelect: () => onMode({ kind: "fit-page" }) },
            { label: "Actual size", shortcut: "Ctrl+1", checked: mode.kind === "custom" && mode.zoom === 1, onSelect: () => onMode({ kind: "custom", zoom: 1 }) },
            { kind: "separator" },
            ...PRESETS.map((z) => ({
              label: formatZoom(z),
              checked: mode.kind === "custom" && Math.abs(mode.zoom - z) < 1e-6,
              onSelect: () => onMode({ kind: "custom", zoom: z }),
            })),
          ]}
        />
      )}
    </div>
  );
}
