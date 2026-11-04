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

## Editing (Phase 2)

- Every change runs inside a MuPDF journal operation (`PdfEngine.edit`), so undo/redo is MuPDF's own and covers
  annotations, form values and imports alike. "Unsaved" = journal position differs from the position at the last save.
- Edits return the pages they touched; `DocData.invalidate` drops those pages' caches and bumps their render keys,
  so only affected pages re-render.
- Annotation overlays (`AnnotLayer`) and form overlays (`FormLayer`) are HTML on top of each page. Forms use real
  inputs that are transparent until focused, so the PDF's own appearance shows but keyboard and screen readers work.
- Form scripts are never executed. `formScripts.ts` recognises Acrobat's standard helpers and parses simple arithmetic
  into an AST; anything else is counted and reported.
- Signing adds a signature dictionary with fixed-width placeholders, saves incrementally, patches /ByteRange, hashes
  the covered bytes and embeds a CMS (PKI.js on WebCrypto; PKCS#12 parsing by node-forge). Verification re-hashes
  the exact file bytes, which the engine keeps in sync after every save.
- Crash recovery: the desktop app writes unsaved documents to `%LOCALAPPDATA%\com.miishat.pdforge\recovery` every 30 s.

## Organising and editing (Phase 3)

- Page operations use MuPDF's `rearrangePages` and graft maps, inside journal operations, so they're undoable. Any edit
  that may change page count or size returns `pages: null`; the UI then refetches `DocInfo` and re-lays out.
- Headers/footers, watermarks and backgrounds are separate content streams recorded in the page's `/PDForgeMarks`, so
  they can be replaced or removed without parsing the original content. The original content is wrapped in q/Q first.
- Text editing removes a line with a text-only redaction, then writes the new text at the same baseline: with the
  line's own font (embedded via `addFont`, Identity-H, ToUnicode kept for search) if it has every glyph, else a
  matching standard font. Image moves remove the image by redaction and re-add the same image XObject.
- Redaction uses MuPDF's `applyRedactions`. Because incremental saves keep earlier revisions, the engine sets
  `requireFullSave` after redaction or sanitising, and the next save is a full, garbage-collected rewrite.

## Transform and protect (Phase 4)

- Security is applied when the file is written (MuPDF save options `encrypt=aes-256,…`), so the engine keeps a
  pending change and the tab counts as unsaved. After the save, the document is reloaded from the written bytes and
  unlocked with the owner password. MuPDF's `needsPassword()` forgets an earlier authentication, so the engine records
  it once at open and never calls it afterwards.
- Compression measures each image's on-page size with a custom `Device` (image pointers match `loadImage`, thanks to
  MuPDF's store), downsamples in JS with area averaging, re-encodes as JPEG and keeps the result only when smaller.
  Save options that change the document they write (`objstms`, `clean`) go through a temporary copy, so saving never
  adds an undo step.
- Conversions to Markdown, HTML and DOCX share one inferred model (headings from font size relative to the body size,
  paragraphs from spacing, list items from markers, runs from per-character font styles). DOCX is written with a
  small ZIP writer (`src/core/zip.ts`, platform `CompressionStream`). Office, HTML, text, e-books and images are laid
  out by MuPDF's own document handlers and written with its PDF `DocumentWriter`.
- PDF/A-2b conversion fixes what it can (standard fonts embedded from MuPDF's built-in URW CFF programs as WinAnsi
  Type1C fonts, a generated sRGB ICC profile as output intent, XMP metadata matching the Info dictionary, actions,
  attachments, annotation flags/appearances) and reports the rest. It is a checker, not a certified validator.
- OCR: Tesseract (tesseract.js 7, LSTM-only WebAssembly cores) runs in its own worker. A Vite plugin serves the
  worker, cores and the English model from `/tesseract/`, so nothing loads from a CDN; other languages are fetched
  on request into the IndexedDB cache Tesseract reads. Tesseract returns a text-only PDF per page image (glyph-less
  embedded font, invisible text); the engine places it as a form XObject mapped from image space to the page
  (`/PDForgeOCR` marks it for replacement). Deskewing rotates the page content by Tesseract's detected angle so the
  scan and the text layer line up.
- `vite preview` sends the desktop app's CSP, so end-to-end tests run under the same rules as the app.

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
