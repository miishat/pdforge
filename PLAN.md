# PDForge: architecture plan

The full brief is in [docs/PROMPT.md](docs/PROMPT.md); progress is tracked in [docs/FEATURES.md](docs/FEATURES.md).

## Shape of the app

```
 Windows shell (Tauri 2, Rust)            UI thread (React, WebView2)             Engine worker
 ───────────────────────────────          ─────────────────────────────          ─────────────────────────
 file I/O (read_file, later atomic save)  App ─ TitleBar (tabs, window controls)  PdfEngine (src/core/engine.ts)
 launch file from Explorer (launch_file)       ├ StartScreen / PasswordPrompt      └ MuPDF WASM (AGPL)
 native dialogs (plugin-dialog)                └ Viewer ─ PageView × N
 later: OCR (Tesseract), qpdf, signing    platform/ (only place that knows    ◄── protocol.ts messages ──►
                                          Tauri vs browser)                       ImageBitmaps transferred back
```

- **Engine (`src/core`)**: DOM-free TypeScript over MuPDF. Runs in a Web Worker in the app and directly in
  Node for unit tests, and later the `pdforge` CLI. Every tool (merge, redact, OCR…) gets a headless
  function here first, then a UI panel and a command-palette entry.
- **Worker protocol (`protocol.ts`)**: typed request/response messages. Page renders come back as
  transferred `ImageBitmap`s (zero-copy). The worker installs its message handler before MuPDF finishes loading,
  so no message is lost during WASM start-up.
- **UI (`src/ui`)**: React. All visuals read from `src/styles/tokens.css`.
- **Platform (`src/platform`)**: Tauri calls behind small functions with a browser fallback, so the whole UI
  runs in plain Chromium for development and Playwright tests.
- **Shell (`src-tauri`)**: as thin as possible. Native-only work lives here: file access, OS integration,
  and later tools that need native binaries (Tesseract, qpdf) or certificate stores.

## Rendering

- Continuous vertical layout; every page is a correctly-sized placeholder, so the scrollbar is right immediately.
- An IntersectionObserver marks pages within 1200px of the viewport as active; only active pages hold bitmaps.
- Pages render at `zoom × 96/72 × devicePixelRatio`, so text is sharp at any Windows display scaling.
- On zoom, the old bitmap is stretched instantly and a sharp one replaces it about 140ms later. The scroll position
  is anchored to the page under the top of the viewport.

## Key risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Render queue backs up on fast scroll through huge files | Phase 1: cancellable, priority-ordered render queue (visible pages first), tile rendering above ~4000px |
| Saving must never corrupt a file | Rust-side atomic write (temp + rename), incremental saves via MuPDF, crash-recovery journal |
| Custom title bar loses Windows 11 Snap Layouts | Phase 1: answer `WM_NCHITTEST` with `HTMAXBUTTON` for the maximize button (native subclass) |
| WebView2 missing on old Windows 10 | NSIS installer bootstraps WebView2 (Tauri default) |
| Text editing in existing PDFs is inherently limited | Scoped to line/block edits with embedded-font checks; clear warnings (see brief) |
| Unsigned installer triggers SmartScreen | Acceptable for personal use; documented in README |
| MuPDF AGPL | Personal, non-distributed use; app is licensed AGPL-3.0-or-later to stay compatible |

## Testing

- `npm test`: Vitest unit tests on the engine (runs MuPDF in Node) and pure UI logic.
- `npm run test:e2e`: Playwright drives the built UI in Chromium (same engine as WebView2).
- `npm run fixtures`: regenerates the PDF corpus in `tests/fixtures`.
- CI (`.github/workflows/windows.yml`): tests on Linux; `windows-latest` builds the NSIS + MSI installers.
