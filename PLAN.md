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

- Layout (`src/ui/layout.ts`) computes a box for every page (single, two-page, or two-page with a cover; any rotation).
  Only pages within one viewport of the visible area are mounted, so 1,000-page files stay light.
- Renders go through a UI-side priority queue (`EngineClient.render`): at most two in flight, nearest pages first,
  and requests for pages that scrolled away are dropped before they reach the worker.
- Pages render at `zoom × 96/72 × devicePixelRatio`. Each page's base bitmap is capped at 12 MP; beyond that, a
  viewport-sized detail tile is rendered on top at full resolution.
- On zoom/rotate/layout changes, the scroll position is re-anchored to the same spot on the same page (or the cursor
  position for Ctrl+wheel), using the scroll offset from *before* the change.

## Text, search and selection

- The engine returns a per-page `TextLayer`: text in reading order plus a quad and line number per character.
- Selection, word/line snapping, copy and highlight geometry are pure functions in `src/core/textlayer.ts`
  running on the UI thread, so dragging is instant. Search runs in the worker in 25-page batches.

## Key risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Render queue backs up on fast scroll through huge files | Done in Phase 1: cancellable, priority-ordered queue and detail tiles |
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
