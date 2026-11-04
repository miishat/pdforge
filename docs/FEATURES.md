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
- ✅ Modes: Read · Comment · Fill & Sign (Ctrl+Shift+1/2/3), each with its own small toolbar
- ✅ Undo/redo for every change (Ctrl+Z, Ctrl+Y), labelled ("Undo add rectangle")
- ✅ Save (Ctrl+S, incremental: existing signatures stay valid), Save As (Ctrl+Shift+S), atomic writes on Windows
- ✅ Unsaved-changes dot on tabs; asks before closing a tab or the window
- ✅ Crash recovery: unsaved work is copied every 30 s and offered back on the next start (desktop)
- ✅ Text markup: highlight, underline, strikethrough, squiggly, by dragging over text or from a selection / right-click
- ✅ Sticky notes with a popup editor; text boxes typed on the page; callouts with a leader line
- ✅ Shapes: rectangle, ellipse, line, arrow, polygon, connected lines (Shift constrains); freehand drawing
- ✅ 14 standard stamps (Approved, Draft, Confidential…)
- ✅ Measurement: distance, perimeter and area at a settable scale (1 in = N unit), with Acrobat-compatible /Measure data
- ✅ Select, move (drag or arrow keys), resize rectangle-based items, delete (Del); colour, fill, width, opacity and font size
- ✅ Comments panel: threads with replies, review status (Accepted/Rejected/Cancelled/Completed), inline editing,
  search, filter by type/author/status
- ✅ XFDF export/import (Acrobat's comment exchange format), with replies kept as threads
- ✅ Form filling: text, multi-line, number, date (date picker), checkbox, radio, dropdown, list, editable combo;
  Tab order; highlight fields; required-field marking; read-only fields respected
- ✅ Calculated and formatted fields via a safe interpreter (no document code runs): AFSimple_Calculate, simplified field
  notation, simple `event.value = …` scripts, AFNumber/Percent/Date/Special formats. Other scripts are reported, not run
- ✅ Clear form; flatten comments and/or fields (with a clear warning that it can't be undone)
- ✅ Fill & Sign: add text, today's date, ✓, ✗, •; handwritten signature and initials (type in an installed handwriting
  font, draw with mouse/pen/finger, or upload an image with the white background removed), saved on this computer
- ✅ Certificate signatures (PAdES, ETSI.CAdES.detached, SHA-256, RSA or EC keys) from .pfx/.p12 files, visible box with
  optional handwritten image, reason and location; signs into existing empty signature fields too
- ✅ Signature verification: intact / changed after signing / invalid, signer, time, reason, self-signed detection,
  "Trust this signer" (by certificate fingerprint), banner and Signatures panel
- 🟡 Not yet: RFC 3161 timestamps, Windows certificate store and smart cards, certificate chain/revocation checks,
  rich-text comments, stamps from custom images in Comment mode (they work via Fill & Sign signatures)

Not verified on real Windows yet: saving over the original file, the Save/Save As dialogs, crash recovery, and the
close-window prompt (all are desktop-only paths; the browser test build downloads instead).

## Phase 3: Organize and edit
- ⬜ Page organizer, merge, split, insert, crop, resize
- ⬜ Headers/footers, page numbers, Bates numbering, watermarks, backgrounds
- ⬜ Edit text and images; edit links, bookmarks, metadata, attachments
- ⬜ True redaction with pattern presets; sanitize document

## Phase 4: Transform and protect
- ⬜ OCR (Tesseract), compress/optimize, passwords and permissions, conversions, PDF/A, repair

## Phase 5: Beyond Acrobat
- ⬜ Compare, batch workflows, command palette, split view, accessibility checker, table extraction, optional AI assistant
