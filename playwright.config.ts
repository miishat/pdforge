import { defineConfig } from "@playwright/test";

// End-to-end tests drive the real UI against a production build: in Chromium (the same engine as WebView2 on
// Windows) by default, or in WebKit (close to WKWebView, the engine of the Mac app) with PW_WEBKIT=1
// (npm run test:e2e:webkit). CI runs both. Set PW_CHROMIUM to use a preinstalled Chromium binary.
const webkit = !!process.env.PW_WEBKIT;
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: webkit ? "test-results/webkit" : "test-results",
  timeout: 30_000,
  // WebKit on Linux (the CI stand-in for the Mac's engine) is less steady with drag and drop and timing than Safari
  // itself, so a failure there gets one retry. Tests that needed it are still listed as "flaky" in the report.
  retries: webkit ? 1 : 0,
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1280, height: 800 },
    browserName: webkit ? "webkit" : "chromium",
    launchOptions: !webkit && process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
