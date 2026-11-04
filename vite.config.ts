import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

/**
 * Text recognition runs offline: Tesseract's worker, its WebAssembly cores (LSTM-only builds,
 * with and without SIMD) and the English model are served from /tesseract/ rather than a CDN.
 */
function ocrAssets(): Plugin {
  const files: Record<string, string> = {
    "worker.min.js": join(pkgDir("tesseract.js"), "dist/worker.min.js"),
    "tesseract-core-lstm.wasm.js": join(pkgDir("tesseract.js-core"), "tesseract-core-lstm.wasm.js"),
    "tesseract-core-simd-lstm.wasm.js": join(pkgDir("tesseract.js-core"), "tesseract-core-simd-lstm.wasm.js"),
    "tesseract-core-relaxedsimd-lstm.wasm.js": join(pkgDir("tesseract.js-core"), "tesseract-core-relaxedsimd-lstm.wasm.js"),
    "lang/eng.traineddata.gz": join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int/eng.traineddata.gz"),
  };
  return {
    name: "pdforge-ocr-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/tesseract\/(.+?)(\?.*)?$/.exec(req.url ?? "");
        const file = m && files[m[1]];
        if (!file) return next();
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [name, file] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName: `tesseract/${name}`, source: readFileSync(file) });
      }
    },
  };
}

// The desktop app's content security policy, also applied to `vite preview` so end-to-end tests
// run under the same rules as the app.
const csp = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")).app.security.csp as string;

// Tauri expects a fixed dev port and must not clear its terminal output.
export default defineConfig({
  plugins: [react(), ocrAssets()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  preview: { headers: { "Content-Security-Policy": csp } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // MuPDF's WASM module uses top-level await; WebView2 is current Chromium.
  build: { target: "esnext", sourcemap: true },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
});
