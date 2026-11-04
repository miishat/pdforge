import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and must not clear its terminal output.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // MuPDF's WASM module uses top-level await; WebView2 is current Chromium.
  build: { target: "esnext", sourcemap: true },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
});
