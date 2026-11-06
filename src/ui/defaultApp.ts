import { useCallback, useEffect, useState } from "react";
import { defaultPdfApp, isDesktop, openDefaultAppSettings } from "../platform";
import { load, save } from "./settings";

const ASKED = "defaultApp.asked";
/** Asked a little after start, after the update check, so the two notices don't arrive together. */
const DELAY_MS = 8_000;

/**
 * Offers once to make PDForge the default PDF app, when it isn't. Windows doesn't let apps make themselves the
 * default, so "Make default" opens PDForge's page in Settings > Default apps.
 */
export function useDefaultAppOffer(blocked: boolean) {
  const [offer, setOffer] = useState(false);

  useEffect(() => {
    if (!isDesktop || load(ASKED, false)) return;
    const t = window.setTimeout(() => {
      void defaultPdfApp().then((state) => state === "no" && setOffer(true));
    }, DELAY_MS);
    return () => window.clearTimeout(t);
  }, []);

  const dismiss = useCallback(() => {
    save(ASKED, true);
    setOffer(false);
  }, []);

  /** Opens Settings. Resolves to an error message, or null when Settings opened. */
  const makeDefault = useCallback(async (): Promise<string | null> => {
    save(ASKED, true);
    setOffer(false);
    try {
      await openDefaultAppSettings();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  return { offer: offer && !blocked, dismiss, makeDefault };
}
