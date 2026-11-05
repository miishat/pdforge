import type * as mupdf from "mupdf";

/**
 * A page's text as searching sees it. Identical to the text of the page's text layer (lines joined by one newline),
 * but several times quicker to get because no per-character positions are read.
 */
export function plainPageText(doc: mupdf.Document, pageIndex: number): string {
  const page = doc.loadPage(pageIndex);
  try {
    const stext = page.toStructuredText("preserve-whitespace,dehyphenate");
    try {
      // asText ends every line with a newline and separates blocks with an empty line.
      return stext.asText().replace(/\n+/g, "\n").replace(/\n$/, "");
    } finally {
      stext.destroy();
    }
  } finally {
    page.destroy();
  }
}
