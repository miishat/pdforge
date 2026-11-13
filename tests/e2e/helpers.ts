import type { Download } from "@playwright/test";

/**
 * A download's file name as the app chose it. WebKit's test browser replaces spaces with underscores in download
 * names (the desktop apps save through their own dialog instead), so names are compared with spaces.
 */
export const downloadName = (d: Download) => d.suggestedFilename().replace(/_/g, " ");
