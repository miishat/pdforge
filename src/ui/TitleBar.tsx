import { Dismiss16Regular, Square16Regular, Subtract16Regular } from "@fluentui/react-icons";
import { isDesktop, windowAction } from "../platform";
import { Mark } from "./Mark";

interface Props {
  tabTitle: string | null;
  onCloseTab: () => void;
}

export function TitleBar({ tabTitle, onCloseTab }: Props) {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar__brand" data-tauri-drag-region>
        <Mark size={16} />
      </div>
      <div className="titlebar__tabs" role="tablist" data-tauri-drag-region>
        {tabTitle && (
          <div className="tab tab--active" role="tab" aria-selected="true" title={tabTitle}>
            <span className="tab__label">{tabTitle}</span>
            <button className="tab__close" aria-label={`Close ${tabTitle}`} title="Close (Ctrl+W)" onClick={onCloseTab}>
              <Dismiss16Regular />
            </button>
          </div>
        )}
      </div>
      {isDesktop && (
        <div className="window-controls">
          <button aria-label="Minimize" onClick={() => windowAction("minimize")}>
            <Subtract16Regular />
          </button>
          <button aria-label="Maximize" onClick={() => windowAction("toggleMaximize")}>
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
