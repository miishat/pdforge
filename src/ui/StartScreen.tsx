import { FolderOpen20Regular } from "@fluentui/react-icons";
import { Mark } from "./Mark";

export function StartScreen({ onOpen }: { onOpen: () => void }) {
  return (
    <main className="start">
      <div className="start__inner">
        <div className="start__brand">
          <Mark size={28} />
          <span className="start__wordmark">PDForge</span>
        </div>
        <button className="button button--primary button--large" onClick={onOpen}>
          <FolderOpen20Regular />
          Open a PDF
          <kbd>Ctrl+O</kbd>
        </button>
        <p className="start__hint">Or drag a file into this window.</p>
      </div>
    </main>
  );
}
