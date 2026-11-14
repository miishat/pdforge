// Printing: pages are rendered to images and handed to the system print dialog (WebView2's print preview),
// each on a CSS named page sized like the original, so mixed portrait/landscape documents print correctly.
import { engine } from "../../core/client";
import type { DocInfo } from "../../core/types";
import { isDesktop, isMac } from "../../platform";

/** How long the Mac app keeps printed pages after you're back in the window, while the print job may still read them. */
const MAC_PRINT_KEEP_MS = 60_000;
/** Clears the pages of a Mac print that may still be in use (run before the next print). */
let pendingCleanup: (() => void) | null = null;

export async function printPages(
  info: DocInfo,
  pages: number[],
  dpi: number,
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<void> {
  pendingCleanup?.();
  const urls: string[] = [];
  const root = document.createElement("div");
  root.id = "print-root";
  const style = document.createElement("style");
  const sizes = new Set<string>();
  try {
    for (let i = 0; i < pages.length; i++) {
      if (signal.aborted) return cleanup();
      const p = pages[i];
      const bytes = await engine().call("renderImage", { docId: info.docId, pageIndex: p, scale: dpi / 72, rotation: 0 }, "jpeg");
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
      urls.push(url);
      const { width, height } = info.pages[p];
      const name = `p${Math.round(width)}x${Math.round(height)}`;
      sizes.add(`@page ${name} { size: ${width}pt ${height}pt; margin: 0; }`);
      const page = document.createElement("div");
      page.className = "print-page";
      page.style.cssText = `page: ${name}; width: ${width}pt; height: ${height}pt;`;
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      page.appendChild(img);
      root.appendChild(page);
      onProgress(i + 1);
    }
    style.textContent = [...sizes].join("\n");
    document.head.appendChild(style);
    document.body.appendChild(root);
    await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    if (signal.aborted) return cleanup();
    if (isDesktop && isMac) {
      // The Mac app's print panel doesn't block (window.print() returns as it opens), and the print job reads the
      // pages after it closes, so they stay until a while after you're back in the window.
      await window.print();
      keepUntilBack(cleanup);
      return;
    }
    window.print();
  } catch (err) {
    cleanup();
    throw err;
  }
  // window.print() blocks until the dialog closes, so it's safe to clean up now.
  cleanup();

  function cleanup() {
    root.remove();
    style.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}

function keepUntilBack(cleanup: () => void) {
  let timer = 0;
  const done = () => {
    window.clearTimeout(timer);
    window.removeEventListener("pointerdown", back, true);
    window.removeEventListener("keydown", back, true);
    pendingCleanup = null;
    cleanup();
  };
  // The panel is modal, so a click or key press in the window means it has closed.
  const back = () => {
    window.removeEventListener("pointerdown", back, true);
    window.removeEventListener("keydown", back, true);
    timer = window.setTimeout(done, MAC_PRINT_KEEP_MS);
  };
  window.addEventListener("pointerdown", back, true);
  window.addEventListener("keydown", back, true);
  pendingCleanup = done;
}
