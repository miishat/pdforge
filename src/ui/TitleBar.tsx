import { Add16Regular, Dismiss16Regular, Square16Regular, Subtract16Regular, LockClosed12Regular } from "@fluentui/react-icons";
import { useEffect, useRef } from "react";
import { isDesktop, showSnapLayouts, windowAction } from "../platform";
import { Mark } from "./Mark";
import type { Tab } from "./useTabs";

interface Props {
  tabs: Tab[];
  activeId: number | null;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}

/** How long the pointer rests on maximize before the Snap Layouts flyout opens (about what Windows 11 waits). */
const SNAP_HOVER_MS = 500;

export function TitleBar({ tabs, activeId, onActivate, onClose, onNew }: Props) {
  // PDForge draws its own maximize button, so Windows can't show Snap Layouts over it by itself.
  const snapTimer = useRef<number | undefined>(undefined);
  const cancelSnap = () => window.clearTimeout(snapTimer.current);
  const armSnap = () => {
    cancelSnap();
    snapTimer.current = window.setTimeout(() => void showSnapLayouts(), SNAP_HOVER_MS);
  };
  useEffect(() => cancelSnap, []);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar__brand" data-tauri-drag-region>
        <Mark size={16} />
      </div>
      <div className="titlebar__tabs" role="tablist" aria-label="Open documents" data-tauri-drag-region>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? "tab--active" : ""}`}
            role="tab"
            aria-selected={t.id === activeId}
            tabIndex={t.id === activeId ? 0 : -1}
            title={t.path ?? t.name}
            onClick={() => onActivate(t.id)}
            onAuxClick={(e) => e.button === 1 && onClose(t.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onActivate(t.id)}
          >
            {t.state.kind === "locked" && <LockClosed12Regular className="tab__icon" />}
            <span className="tab__label">{t.name}</span>
            {t.dirty && <span className="tab__dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
            <button
              className="tab__close"
              aria-label={`Close ${t.name}`}
              title="Close (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <Dismiss16Regular />
            </button>
          </div>
        ))}
        {tabs.length > 0 && (
          <button className="titlebar__new" aria-label="Open a file" title="Open (Ctrl+O)" onClick={onNew}>
            <Add16Regular />
          </button>
        )}
        <div className="titlebar__drag" data-tauri-drag-region />
      </div>
      {isDesktop && (
        <div className="window-controls">
          <button aria-label="Minimize" onClick={() => windowAction("minimize")}>
            <Subtract16Regular />
          </button>
          <button
            aria-label="Maximize"
            onClick={() => (cancelSnap(), void windowAction("toggleMaximize"))}
            onPointerEnter={armSnap}
            onPointerLeave={cancelSnap}
            onPointerDown={cancelSnap}
          >
            <Square16Regular />
          </button>
          <button className="window-controls__close" aria-label="Close" onClick={() => windowAction("close")}>
            <Dismiss16Regular />
          </button>
        </div>
      )}
    </header>
  );
}
