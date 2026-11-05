import type { AvailableUpdate } from "../platform";
import { openExternal } from "../platform";
import type { UpdateState } from "./updates";

const RELEASES = "https://github.com/miishat/pdforge/releases";

/** A one-line notice under the title bar about a new version: install it, see what's new, or leave it for later. */
export function UpdateBar({ state, onInstall, onDismiss, onRetry }: {
  state: UpdateState;
  onInstall: (u: AvailableUpdate) => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  if (state.kind === "idle") return null;
  if (state.kind === "checking")
    return (
      <div className="infobar app-notice" role="status">
        Checking for updates…
      </div>
    );
  if (state.kind === "upToDate")
    return (
      <div className="infobar infobar--good app-notice" role="status">
        PDForge {state.version} is the latest version.
        <button className="link-button" onClick={onDismiss}>Dismiss</button>
      </div>
    );
  if (state.kind === "error")
    return (
      <div className="infobar infobar--bad app-notice" role="alert">
        {state.message}
        <button className="link-button" onClick={onRetry}>Try again</button>
        <button className="link-button" onClick={onDismiss}>Dismiss</button>
      </div>
    );
  if (state.kind === "downloading")
    return (
      <div className="infobar infobar--accent app-notice" role="status" aria-live="polite">
        Downloading PDForge {state.version}{state.percent != null ? `… ${state.percent}%` : "…"} PDForge will close and reopen to finish.
        {state.percent != null && <progress className="update-progress" max={100} value={state.percent} aria-label="Download progress" />}
      </div>
    );
  const { update } = state;
  return (
    <div className="infobar infobar--accent app-notice" role="status">
      <span>
        PDForge {update.version} is available <span className="muted">(you have {update.currentVersion})</span>.
      </span>
      <button className="button button--small button--primary" onClick={() => onInstall(update)}>
        Update and restart
      </button>
      <button className="link-button" onClick={() => void openExternal(`${RELEASES}/tag/v${update.version}`)}>What's new</button>
      <button className="link-button" onClick={onDismiss}>Later</button>
    </div>
  );
}
