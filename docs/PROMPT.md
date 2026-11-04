# Build Prompt: "PDForge", a local-first PDF suite to replace Adobe Acrobat

## Role & Mission
You are a senior desktop-application engineer with a strong product-design eye. Build **PDForge**, a desktop PDF
application that fully replaces Adobe Acrobat Reader and covers the most-used Acrobat Pro features, plus extras.
It must be **fast, offline, private (no telemetry, no account, no cloud)** and a genuine pleasure to use every day
as the system's default PDF app.

**Context:** a personal, single-user, non-commercial tool. **Windows 10/11 is the target platform for now.**
Keep the code cross-platform-ready (no needless Windows-only APIs in the core) so macOS and Linux can be added later,
but only build, test and polish for Windows until told otherwise.

Work in phases (below). At the end of each phase the app must build, run, pass its tests, and be committed.
Do not stub features and call them done. If something can't be done well, say so plainly and propose an alternative.

## Tech Stack (use unless there's a strong, stated reason not to)
- **Shell:** Tauri 2 (Rust backend, WebView2 on Windows) gives a small binary, native file associations, and a later path to macOS/Linux.
- **UI:** React + TypeScript + Vite, Tailwind, Radix UI primitives. Light and dark themes, plus high contrast.
- **PDF engine:** MuPDF (via `mupdf` WASM/JS bindings or Rust bindings) for rendering, text extraction,
  annotations, redaction, and saving. Use PDF.js only if MuPDF falls short for a specific feature.
  Use `pdf-lib` for simple structural edits if it's easier. MuPDF is AGPL; that's acceptable here because this is personal, non-distributed use.
  Any license that permits personal use is fine, so pick the best tool for the job, not the most permissive license.
- **Encryption / linearize / repair:** qpdf (bundled CLI or library).
- **OCR:** Tesseract (bundled, with language packs on demand), output as an invisible text layer (like OCRmyPDF).
- **Signatures:** PAdES (PDF Advanced Electronic Signatures) via a Rust crypto stack, or a vetted library.
  Supports PKCS#12 (.p12/.pfx) certificates, timestamps from an RFC 3161 timestamp server (optional, the only network call, off by default),
  and validating existing signatures.
- **Conversion:** LibreOffice headless (optional dependency, detected at runtime) for Office↔PDF;
  built-in for images↔PDF, PDF→text/Markdown/HTML.
- **Storage:** SQLite for recent files, settings, saved signatures, stamps, and bookmarks.
- Vet every dependency (real publisher, maintained, license compatible) before adding it.

## Architecture Requirements
- Heavy work (render, OCR, compress, convert) runs in Rust/worker threads; the UI never blocks.
  Long jobs show progress and can be cancelled.
- Document model with a **full undo/redo stack** for every edit, including page operations.
- Saving never destroys data: incremental save where possible, atomic write (temp file + rename),
  auto-recovery of unsaved changes after a crash.
- Tile-based, cached rendering that loads pages lazily. A 1,000-page PDF must open in under 1.5s and scroll at 60fps.
- Plugin-friendly "Tools" registry: every tool is a module with a UI panel and a headless function,
  so the same operation works from the GUI, the command palette, and the CLI.
- **CLI companion** (`pdforge merge a.pdf b.pdf -o out.pdf`, `pdforge ocr`, `pdforge compress`, …) built on the same core.

## Feature Scope

### Phase 1: Viewer (Acrobat Reader parity)
- Open PDF and PDF/A files; tabs; recent files; drag-and-drop; registered as the OS default PDF handler.
- Zoom (fit width/page, actual size, marquee zoom), rotate view, single/two-page/continuous/book layouts.
- Sidebar: thumbnails, outline/bookmarks, attachments, layers (optional content), annotations list.
- Full-text search with regex, case and whole-word options, hit list, and highlighting of all hits.
- Text and area selection, copy (keeps reading order), copy as image.
- Link navigation, back/forward history, go-to-page.
- Presentation/full-screen mode, read-aloud (OS text-to-speech), night/sepia reading modes.
- Print with page ranges, scaling, booklet, N-up, print-as-image fallback.
- Document properties (metadata, fonts, security, PDF version).
- Password-protected files open correctly.

### Phase 2: Annotate, fill and sign
- Highlight, underline, strikethrough, squiggly, sticky notes, free text, callouts, shapes, lines and arrows,
  freehand ink, stamps (built-in and custom), measurement tools (distance, area, perimeter, with scale).
- Comment threads with replies and status; filter by author/type; export/import comments as XFDF.
- AcroForm filling: text, checkbox, radio, dropdown, list, date pickers; tab order; calculated fields
  (run form JavaScript in a sandbox, limited to the safe subset). Flatten forms.
- Fill & Sign: draw, type, or image signatures and initials, saved for reuse; date/check/cross marks.
- Certificate digital signatures (PAdES): sign, verify, show signature panel with validity status.
- Annotations must stay compatible: they render the same in Acrobat, Chrome, and macOS Preview.

### Phase 3: Organize and edit (Acrobat Pro parity)
- Page organizer grid: reorder by drag, insert (blank, from file, from image, from scanner where the OS supports it),
  delete, rotate, extract, duplicate, replace, split (by count, size, bookmarks, ranges).
- Merge many files into one, with ordering, bookmarks per source, and dedupe of fonts and resources.
- Crop, resize page, add/remove margins, headers/footers, page numbers, Bates numbering, watermarks, backgrounds.
- **Edit text** (single line or block within its box, matching font when it's embedded and has
  the needed glyphs, otherwise a clear fallback warning), add new text, replace/move/resize images.
- Edit links, bookmarks, metadata, and attachments.
- **True redaction:** mark text, area, or search pattern (built-in presets: emails, phone numbers, SSNs, cards),
  then apply, which permanently removes the underlying content. Also a "sanitize document" option that
  removes metadata, hidden layers, embedded JavaScript, and attachments.

### Phase 4: Transform and protect
- OCR: page or document, multiple languages, deskew, makes scanned PDFs searchable and selectable.
- Compress/optimize with presets (screen, ebook, print, custom: image DPI, JPEG quality, font subsetting,
  remove unused objects). Show size before and after.
- Security: password to open, permissions (print/copy/edit), AES-256; remove security (with the password).
- Convert: PDF → images (PNG/JPEG/TIFF), text, Markdown, HTML, DOCX (best effort, clearly labeled);
  images/Office/HTML → PDF; PDF → PDF/A (with a validation report).
- Repair corrupted PDFs.

### Phase 5: Beyond Acrobat
- **Compare** two PDFs: text and visual diff, side by side, with changes listed.
- **Batch actions:** chain tools into saved workflows (e.g. OCR → compress → watermark) and run them on folders.
- Command palette (Ctrl+K) for every action; fully rebindable keyboard shortcuts; vim-style navigation option.
- Split view of two documents, synced scrolling.
- Accessibility checker (tags, alt text, reading order) with fix-ups for simple issues.
- Table extraction to CSV/XLSX.
- **Optional, off by default:** a local AI assistant (via a user-supplied API key, or a local model) to
  summarize, ask questions about the document with page citations, and suggest form-fill values. Never sends
  anything without an explicit per-use confirmation.

## Design Direction (this matters as much as the features)
Goal: **effortless to use, and with a clear identity of its own.** It should feel like a carefully crafted native
Windows tool made by someone who loves documents, *not* like a generic AI-generated web dashboard.

**Principles**
- **The document is the hero.** Chrome recedes: thin, quiet toolbars; panels collapse; a distraction-free mode hides everything.
  The page canvas gets a soft neutral backdrop, and pages get a real-paper shadow.
- **Native on Windows.** Custom title bar with tabs in it (like Edge/Explorer), Mica/acrylic backdrop where supported,
  Segoe UI Variable for interface text, follows the Windows accent color option, light/dark theme, scaling (100–200%),
  Snap Layouts on the maximize button, proper right-click menus, and standard shortcuts (Ctrl+O/S/P/F/Z/Y/W/Tab, Ctrl+wheel zoom).
- **Progressive disclosure.** Modes (Read · Comment · Fill & Sign · Organize · Edit · Protect) swap a small context toolbar.
  Common actions are one click; power features live in the command palette (Ctrl+K) and right-click menus, not a wall of icons.
- **Forgiving.** Everything undoable; destructive steps (apply redaction, flatten, overwrite) say exactly what will
  happen in one sentence; nothing loses work.
- **Fast feels friendly.** Instant feedback (<100ms) on every click; skeleton thumbnails instead of spinners; no modal
  dialogs for things a side panel or inline popover can do.

**Visual identity**
- Palette: warm paper-and-graphite neutrals (not cold blue-slate) with **one** accent, a forge-ember/copper used sparingly
  for the active tool, focus and primary action. Annotation colors are a separate, carefully tuned set that reads on white paper.
  All color pairs meet WCAG AA contrast.
- Type: Segoe UI Variable for UI; a clear typographic scale (≈12/13/14/16/20); tabular numbers for page counts and zoom.
- Shape and depth: small radii (4–6px), 1px hairline borders, shadows only where something actually floats.
- Icons: one consistent set at one stroke weight (e.g. Fluent UI System Icons), with tooltips that show the shortcut.
- Motion: 120–180ms ease-out, purposeful only (panel slide, page snap); respects reduced-motion.
- A small, distinctive app icon and an empty start screen that is genuinely useful (recent files with thumbnails,
  drag-and-drop target, pinned folders), not decorative.

**Explicitly avoid (the "generic AI look")**
- Purple/blue gradients, glowing blobs, glassmorphism on everything, neon accents.
- Grids of big rounded cards with drop shadows; dashboard layouts; hero banners; "Welcome back! 👋".
- Emoji as icons, sparkle ✨ icons, "magic"/"AI-powered" labels.
- Default Inter + slate-gray Tailwind/shadcn look left unstyled; pill buttons everywhere; oversized padding.
- Vague microcopy ("Oops! Something went wrong"). Write plain, specific text: "Couldn't save: the file is open in another app."
- Toasts for everything; centered spinners; modal stacks.

**Benchmarks to learn from (for feel, never copy their look):** Windows 11 Photos/Notepad (native polish), Linear
(speed and keyboard-first), Things (calm clarity), Sumatra PDF (instant, lightweight). Aim to beat Acrobat at
"I opened the app and immediately knew what to do."

## Quality Bar
- **Correctness:** keep a test corpus (forms, scanned, encrypted, huge, malformed, right-to-left/CJK, PDF 2.0)
  and run round-trip tests: open → edit → save → reopen in MuPDF *and* PDF.js and pdf-lib, which must succeed with no errors.
- **Security:** treat every PDF as hostile. Parse with sandboxing and limits, never run embedded JS outside the sandbox,
  never auto-open links or launch actions without asking. Fuzz the open/save path.
- **UX:** meets every point of the Design Direction above; a first-time user can open, read, highlight, sign and save
  a PDF without help.
- **Accessibility:** keyboard-only usable, screen-reader labels, follows the system's reduced-motion and contrast settings.
- **Performance budgets:** cold start under 1s, open a 100MB file under 2s, memory under 500MB on a 1,000-page document.
- **Tests:** unit tests for the core, integration tests per tool, Playwright end-to-end tests for the main flows.
  GitHub Actions on `windows-latest` builds the installer and runs the tests on every push.

## Process Rules
1. Start by writing `PLAN.md` (architecture, module layout, risks) and `docs/FEATURES.md` (a checklist mirroring the scope above).
2. Build phase by phase; after each phase, update the checklist, run all tests, and report what works, what's
   partial, and known issues, honestly.
3. Verify features in the running app (screenshots, end-to-end tests), not just by compiling.
4. Produce a Windows installer (NSIS `.exe`, plus `.msi`) that registers the `.pdf` file association, Explorer
   "Open with" entry and Start-menu shortcut, and a README covering install, setting PDForge as the default PDF app in
   Windows Settings, CLI usage, and license notes.
5. Development may happen in a Linux cloud container: iterate on the UI in Chromium/Playwright there, and rely on the
   Windows CI job for the real build. Download and sanity-check the CI installer artifact each phase.
6. After each phase, do a **design review**: screenshot every screen/state touched (light + dark, 100% and 150% scaling),
   check them against the Design Direction below, and fix anything that fails before calling the phase done.

## Start
Begin with Phase 0: scaffold the Tauri + React project, integrate MuPDF rendering of one page, set up tests and the Windows CI build,
write PLAN.md, and create a small design-tokens file (colors, type, spacing, radii, motion) that every component uses. Then proceed to Phase 1.
