// Printing: pages are rendered to images and handed to the system print dialog (WebView2's print preview),
// each on a CSS named page sized like the original, so mixed portrait/landscape documents print correctly.
import { engine } from "../../core/client";
import type { DocInfo } from "../../core/types";

export async function printPages(
  info: DocInfo,
  pages: number[],
  dpi: number,
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const urls: string[] = [];
  const root = document.createElement("div");
  root.id = "print-root";
  const style = document.createElement("style");
  const sizes = new Set<string>();
  try {
    for (let i = 0; i < pages.length; i++) {
      if (signal.aborted) return;
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
    if (signal.aborted) return;
    window.print();
  } finally {
    // window.print() blocks until the dialog closes, so it's safe to clean up now.
    root.remove();
    style.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}
