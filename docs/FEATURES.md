# Feature checklist

Legend: ✅ done and tested · 🟡 partial · ⬜ not started

## Phase 0: Foundation
- ✅ Tauri 2 + React + TypeScript project, Windows NSIS/MSI bundle config with `.pdf` file association
- ✅ MuPDF engine in a Web Worker; pages rendered to transferred bitmaps
- ✅ Design tokens (light/dark, warm neutrals, ember accent) and native-style custom title bar
- ✅ Open via dialog, Ctrl+O, drag and drop, or Explorer double-click / "Open with"
- ✅ Continuous scrolling, lazy rendering, zoom (Ctrl +/−, Ctrl+wheel, Ctrl+0/1/2), page jump
- ✅ Password-protected PDFs; readable error for invalid files
- ✅ Unit tests (engine, zoom), Playwright end-to-end tests, CI building the Windows installer

## Phase 1: Viewer (Acrobat Reader parity)
- ✅ Tabs: open several files, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+W, middle-click to close; reopening a file focuses its tab
- ✅ Single instance: double-clicking a PDF while PDForge is open adds a tab instead of a second window
- ✅ Recent files on the start screen with thumbnails, folder, time, the page you were on (reopens there), and removal
- ⬜ Snap Layouts on the custom maximize button (needs a native window hook; planned)
- ✅ Prioritized, cancellable render queue (visible pages first, stale renders dropped)
- ✅ Sharp detail tile at very high zoom (base bitmap capped at 12 MP)
- ✅ Zoom field (type a value) with presets, Automatic / Fit width / Fit page / Actual size; Ctrl+wheel zooms around the cursor
- ✅ Marquee zoom (Z); rotate view (Ctrl+Shift+Plus/Minus); single, two-page and two-page-with-cover layouts
- ✅ Sidebar (F4): page thumbnails, bookmarks, search results, comments, attachments (save a copy), layers (show/hide).
  Empty panels are hidden
- ✅ Full-text search (Ctrl+F, F3): match case, whole words, regex, live count, highlights, results list; runs in batches
- ✅ Text selection: drag, Shift+click to extend, double-click word, triple-click line, across pages; Ctrl+C, Ctrl+A
- ✅ Snapshot tool (G): copy any area as an image
- ✅ Right-click menu: copy, find selected text, select all, tools, rotate, print, properties
- ✅ Links: internal jumps; external links ask first and only open web and mail links. Back/forward with Alt+←/→
- ✅ Presentation mode (Ctrl+L / F5), read aloud with system voices (Ctrl+Shift+Y), night and sepia reading modes
- 🟡 Print (Ctrl+P): all, current page or a range, at 150 or 300 dpi, using the Windows print dialog for printer,
  paper, copies and scaling. Booklet and N-up printing aren't built yet
- ✅ Document properties (Ctrl+D): description, file, page size, PDF version, encryption, permissions, fonts
- ✅ Respects document permissions for copying and printing
- ✅ Hand tool (H, or hold Space); Home/End; Ctrl+G jumps to the page box

Not verified on real Windows yet (the tests run in Chromium, the same engine as WebView2): printing through the Windows
dialog, the single-instance hand-off, and saving attachments with the native Save dialog.

## Phase 2: Annotate, fill and sign
- ⬜ Text markup, notes, free text, shapes, ink, stamps, measurement
- ⬜ Comment threads, XFDF import/export
- ⬜ Form filling, calculated fields (sandboxed), flatten
- ⬜ Fill & Sign (drawn/typed/image signatures)
- ⬜ Certificate signatures (PAdES): sign and verify

## Phase 3: Organize and edit
- ⬜ Page organizer, merge, split, insert, crop, resize
- ⬜ Headers/footers, page numbers, Bates numbering, watermarks, backgrounds
- ⬜ Edit text and images; edit links, bookmarks, metadata, attachments
- ⬜ True redaction with pattern presets; sanitize document

## Phase 4: Transform and protect
- ⬜ OCR (Tesseract), compress/optimize, passwords and permissions, conversions, PDF/A, repair

## Phase 5: Beyond Acrobat
- ⬜ Compare, batch workflows, command palette, split view, accessibility checker, table extraction, optional AI assistant
