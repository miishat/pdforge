import { Checkmark16Regular } from "@fluentui/react-icons";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuEntry =
  | {
      kind?: "item";
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      /** Shown as a tooltip when disabled, to explain why. */
      reason?: string;
    }
  | { kind: "separator" }
  | { kind: "heading"; label: string };

interface MenuProps {
  entries: MenuEntry[];
  /** Viewport coordinates of the anchor's bottom-left, or a pointer position for context menus. */
  at: { x: number; y: number; alignRight?: boolean };
  onClose: () => void;
  label: string;
}

/** A keyboard-accessible popup menu rendered in a portal. */
export function Menu({ entries, at, onClose, label }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    let left = at.alignRight ? at.x - r.width : at.x;
    let top = at.y;
    left = Math.max(4, Math.min(left, window.innerWidth - r.width - 4));
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, at.y - r.height);
    setPos({ left, top });
    el.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [at]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...ref.current!.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items[items.length - 1]?.focus();
    else if (e.key === "Escape" || e.key === "Tab") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div ref={ref} className="menu" role="menu" aria-label={label} style={pos} onKeyDown={onKeyDown}>
      {entries.map((entry, i) => {
        if (entry.kind === "separator") return <div key={i} className="menu__separator" role="separator" />;
        if (entry.kind === "heading")
          return (
            <div key={i} className="menu__heading" role="presentation">
              {entry.label}
            </div>
          );
        const checkable = entry.checked !== undefined;
        return (
          <div
            key={i}
            role={checkable ? "menuitemcheckbox" : "menuitem"}
            aria-checked={checkable ? entry.checked : undefined}
            aria-disabled={entry.disabled || undefined}
            title={entry.disabled ? entry.reason : undefined}
            tabIndex={-1}
            className="menu__item"
            onClick={() => {
              if (entry.disabled) return;
              onClose();
              entry.onSelect();
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !entry.disabled) {
                e.preventDefault();
                onClose();
                entry.onSelect();
              }
            }}
          >
            <span className="menu__icon">{checkable ? entry.checked && <Checkmark16Regular /> : entry.icon}</span>
            <span className="menu__label">{entry.label}</span>
            {entry.shortcut && <kbd className="menu__shortcut">{entry.shortcut}</kbd>}
          </div>
        );
      })}
    </div>,
    // Inside an open modal dialog, everything outside it is inert, so the menu goes into the dialog.
    portalTarget(),
  );
}

/** A toolbar button that opens a menu below itself. */
export function MenuButton({
  label,
  icon,
  entries,
  text,
  className = "icon-button",
}: {
  label: string;
  icon: ReactNode;
  entries: MenuEntry[] | (() => MenuEntry[]);
  text?: string;
  className?: string;
}) {
  const [open, setOpen] = useState<{ x: number; y: number; alignRight: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        onClick={() => {
          if (open) return setOpen(null);
          const r = btn.current!.getBoundingClientRect();
          const alignRight = r.left > window.innerWidth / 2;
          setOpen({ x: alignRight ? r.right : r.left, y: r.bottom + 4, alignRight });
        }}
      >
        {icon}
        {text}
      </button>
      {open && (
        <Menu
          label={label}
          at={open}
          entries={typeof entries === "function" ? entries() : entries}
          onClose={() => {
            setOpen(null);
            btn.current?.focus();
          }}
        />
      )}
    </>
  );
}

function portalTarget(): Element {
  const dialogs = document.querySelectorAll("dialog[open]");
  return dialogs[dialogs.length - 1] ?? document.body;
}
