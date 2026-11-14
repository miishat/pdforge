import { test as base, type Download } from "@playwright/test";

export { expect, type Page } from "@playwright/test";

/**
 * Playwright's `test`, plus: when a test fails, the browser's errors and warnings are printed with it, so a CI
 * log shows what went wrong inside the page (in Chromium and in WebKit).
 */
export const test = base.extend<{ browserMessages: void }>({
  browserMessages: [
    async ({ page }, use, testInfo) => {
      const lines: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") lines.push(`${m.type()}: ${m.text()}`);
      });
      page.on("pageerror", (e) => lines.push(`uncaught: ${e.message}`));
      await use();
      if (testInfo.status !== testInfo.expectedStatus && lines.length) console.log(`Browser messages in "${testInfo.title}":\n  ${lines.join("\n  ")}`);
    },
    { auto: true },
  ],
});

/**
 * A download's file name as the app chose it. WebKit's test browser replaces spaces with underscores in download
 * names (the desktop apps save through their own dialog instead), so names are compared with spaces.
 */
export const downloadName = (d: Download) => d.suggestedFilename().replace(/_/g, " ");
