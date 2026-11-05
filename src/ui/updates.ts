import { useCallback, useEffect, useRef, useState } from "react";
import { appVersion, checkForUpdate, isDesktop, type AvailableUpdate } from "../platform";
import { load, save } from "./settings";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "upToDate"; version: string }
  | { kind: "error"; message: string };

/** How often PDForge looks for a new version on its own. */
const AUTO_CHECK_EVERY = 6 * 60 * 60 * 1000;

export function autoUpdatesOn(): boolean {
  return load("updates.auto", true);
}
export function setAutoUpdates(on: boolean) {
  save("updates.auto", on);
}

/**
 * Update checks against GitHub Releases. Checks quietly a few seconds after start (at most every few hours);
 * a manual check also reports "up to date" and errors.
 */
export function useUpdates() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const busy = useRef(false);

  const check = useCallback(async (manual: boolean) => {
    if (!isDesktop || busy.current) return;
    busy.current = true;
    if (manual) setState({ kind: "checking" });
    try {
      const update = await checkForUpdate();
      save("updates.lastCheck", Date.now());
      if (update) setState({ kind: "available", update });
      else if (manual) setState({ kind: "upToDate", version: await appVersion() });
      else setState({ kind: "idle" });
    } catch (err) {
      if (manual) setState({ kind: "error", message: friendly(err) });
      else setState({ kind: "idle" });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isDesktop || !autoUpdatesOn()) return;
    if (Date.now() - load("updates.lastCheck", 0) < AUTO_CHECK_EVERY) return;
    const t = setTimeout(() => void check(false), 4000);
    return () => clearTimeout(t);
  }, [check]);

  const install = useCallback(async (update: AvailableUpdate) => {
    setState({ kind: "downloading", version: update.version, percent: 0 });
    try {
      await update.install((done, total) =>
        setState({ kind: "downloading", version: update.version, percent: total ? Math.min(100, Math.round((done / total) * 100)) : null }),
      );
    } catch (err) {
      setState({ kind: "error", message: friendly(err) });
    }
  }, []);

  const dismiss = useCallback(() => setState({ kind: "idle" }), []);
  return { state, check, install, dismiss };
}

function friendly(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/signature/i.test(text)) return "The update's signature didn't match, so it wasn't installed.";
  if (/network|dns|connect|timed? ?out|offline|request/i.test(text)) return "Couldn't reach GitHub to check for updates. Check your internet connection and try again.";
  return `The update couldn't be checked or installed (${text}).`;
}
