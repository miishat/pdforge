import { defineConfig } from "@playwright/test";

// End-to-end tests drive the real UI in Chromium (the same engine as WebView2 on Windows)
// against a production build. Set PW_CHROMIUM to use a preinstalled browser binary.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1280, height: 800 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
