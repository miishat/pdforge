import { Dismiss16Regular, FolderOpen20Regular } from "@fluentui/react-icons";
import { Mark } from "./Mark";
import { timeAgo, type RecentFile } from "./recent";

interface Props {
  recent: RecentFile[];
  missing: Set<string>;
  onOpen: () => void;
  onOpenRecent: (r: RecentFile) => void;
  onRemoveRecent: (r: RecentFile) => void;
}

export function StartScreen({ recent, missing, onOpen, onOpenRecent, onRemoveRecent }: Props) {
  return (
    <main className="start">
      <div className={`start__inner ${recent.length ? "start__inner--with-recent" : ""}`}>
        <div className="start__brand">
          <Mark size={28} />
          <span className="start__wordmark">PDForge</span>
        </div>
        <div className="start__actions">
          <button className="button button--primary button--large" onClick={onOpen}>
            <FolderOpen20Regular />
            Open a PDF
            <kbd>Ctrl+O</kbd>
          </button>
          <p className="start__hint">Or drag files into this window.</p>
        </div>
        {recent.length > 0 && (
          <section className="recent" aria-labelledby="recent-title">
            <h2 id="recent-title" className="recent__title">
              Recent
            </h2>
            <ul className="recent__list">
              {recent.map((r) => {
                const gone = missing.has(r.path);
                return (
                  <li key={r.path} className="recent__item" data-missing={gone || undefined}>
                    <button className="recent__open" onClick={() => onOpenRecent(r)} title={r.path}>
                      <span className="recent__thumb">{r.thumb ? <img src={r.thumb} alt="" /> : null}</span>
                      <span className="recent__text">
                        <span className="recent__name">{r.name}</span>
                        <span className="recent__path">{gone ? "File not found. It may have been moved or deleted." : folderOf(r.path)}</span>
                      </span>
                      <span className="recent__meta">
                        {r.page > 0 ? `Page ${r.page + 1} of ${r.pageCount} · ` : ""}
                        {timeAgo(r.openedAt)}
                      </span>
                    </button>
                    <button className="icon-button icon-button--sm recent__remove" aria-label={`Remove ${r.name} from recent files`} title="Remove from list" onClick={() => onRemoveRecent(r)}>
                      <Dismiss16Regular />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

function folderOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}
