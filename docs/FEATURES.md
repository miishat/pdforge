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
- ✅ Organize mode (Ctrl+Shift+4): page grid with click/Ctrl/Shift selection, keyboard navigation, drag to reorder,
  thumbnail size slider, right-click menu, double-click to open a page
- ✅ Insert blank pages, pages from another PDF (with page range and position, password-protected files too), images as pages
- ✅ Rotate, duplicate, delete (Del), replace pages from another file; everything undoable
- ✅ Extract pages to a new tab or a file, or each page as its own file; optionally remove them afterwards
- ✅ Split every N pages, by ranges ("1-3; 4-10"), or at each top-level bookmark, into a chosen folder
- ✅ Combine files into a new document, in any order, with a bookmark per file
- ✅ Crop by margins (in or mm) or trim to content; change page size (Letter, Legal, Tabloid, A3, A4, A5,
  portrait/landscape) with content scaled to fit
- ✅ Edit mode (Ctrl+Shift+5): edit a line of text in place, keeping its position, size and colour, in the original
  embedded font when it has the needed characters (otherwise a matching standard font, with a notice)
- ✅ Add text (sans/serif/mono, bold, italic, size, colour); add, move, resize, replace and delete images
- ✅ Add and delete links (web, email or a page in the document)
- ✅ Page design: header and footer (left/centre/right, page number, page count, date, file name), page numbers,
  Bates numbering (prefix, start, digits, suffix), text or image watermark (size, rotation, opacity, behind/over),
  background colour. Re-applying replaces; each can be removed
- ✅ Redaction: mark text (drag over it), mark areas, or find and redact (email, phone, US SSN, card numbers with Luhn
  check, IBAN, dates, IP addresses, or your own words/regex). Marks are reviewed first, then applied: text is removed,
  covered image pixels blanked (or whole images removed), covered drawings removed. The next save rewrites the whole
  file, so nothing survives in an earlier revision
- ✅ Remove hidden information: properties/XMP metadata, scripts and launch actions, attachments, comments, private
  application data, embedded thumbnails (with a report of what was removed)
- ✅ Edit bookmarks (add, rename, re-point, move, indent/outdent, delete), document title/author/subject/keywords,
  and attachments (add, remove)
- 🟡 Not yet: editing whole paragraphs with reflow (edits are per line), editing rotated text, scanner input,
  removing content in hidden layers, non-Latin text in headers/watermarks (standard fonts only)

## Phase 4: Transform and protect
- ✅ Protect mode (Ctrl+Shift+6) with Security, Recognise text, Compress, Export, PDF/A and Repair
- ✅ Security: AES-256 encryption; password to open; permissions (print full/low quality/none, copy, change content,
  comments, forms, page assembly, screen readers) behind a permissions password. Applied on save and can be cancelled
  before then. Files with an owner password need it before their security can be changed. Remove security;
  weak (RC4/40-bit) encryption is flagged
- ✅ OCR with Tesseract 5 (tesseract.js), fully offline for English. Other languages (30 listed) are downloaded once on
  request, then cached. Adds an invisible, searchable and selectable text layer that lines up with the printed words;
  straightens skewed scans; skips pages that already have text unless asked; re-running replaces the earlier layer;
  progress, cancel, one undo step
- ✅ Compress: Screen (72 dpi), E-book (150 dpi), Print (300 dpi) or custom (resolution, JPEG quality, recompress,
  font subsetting, duplicate/unused object removal, object streams). Images are measured where they're drawn and
  downsampled with area averaging; new images are kept only when smaller. Shows the size before and after, with Undo
- ✅ Export: Word (.docx), Markdown, HTML (headings, paragraphs, bulleted/numbered lists, bold/italic/code, images),
  plain text, and images (PNG, JPEG with quality, TIFF incl. multi-page) at 72–600 dpi, for all pages or a range.
  Reflowed formats are best effort and say so
- ✅ Create PDFs from Word, Excel, PowerPoint, HTML, text, EPUB, FictionBook, CBZ and images (PNG, JPEG, GIF, BMP,
  TIFF, JXR): from the start screen (several files combine into one), by dropping or opening them. Text stays text;
  paper size follows the region (Letter/A4)
- ✅ PDF/A-2b: check (encryption, fonts, output intent, scripts and actions, attachments, annotation flags and
  appearances, forms/XFA, LZW/interpolation, CMYK, layers, page sizes, XMP identification) with a pass/fixed/fail
  report, and convert: embeds standard fonts (metric-compatible URW fonts), adds an sRGB output intent and matching
  XMP/Info metadata, removes scripts, forbidden actions and attachments, fixes annotations. One undo step
- ✅ Repair: damaged files (broken cross-reference tables, missing header, junk before the header, truncation) are
  rebuilt on open with a notice; Repair checks every page and writes a clean full rewrite
- 🟡 Not yet: PDF/A for files with unembedded non-standard fonts or CMYK content (reported, not fixed); certified PDF/A
  validation (the report isn't veraPDF, which I couldn't run in this environment); DOCX tables and multi-column
  reflow; layout-preserving (absolutely positioned) HTML; OCR of rotated (90°) pages without first rotating them;
  Office import is MuPDF's (simple formatting only); passwords with commas or "=" (MuPDF option syntax)

## Phase 5: Beyond Acrobat
- ✅ Command palette (Ctrl+K): every action (59 commands), searched by words in any order, with shortcuts shown and
  recently used commands first
- ✅ Fully rebindable shortcuts (Keyboard shortcuts…): click a command and press the new keys; conflicts move the
  shortcut instead of doubling it; per-command reset or reset all; reserved Windows keys refused. Saved
- ✅ Vim-style navigation option: j/k scroll, d/u half screen, h/l previous/next page, gg/G first/last, / find, n/N results
- ✅ Split view (Ctrl+\\): two open documents side by side, each with its full toolbar (compact at narrow widths),
  scrolling together (optional); click a side to work in it
- ✅ Compare two PDFs: word-level text diff across the whole document (moved page breaks and reflow don't count;
  typographic quotes and dashes are treated as equal), plus a pixel diff per page for pictures and drawings.
  Side by side with highlights (removed / added / changed / other), synchronised scrolling, and a change list with filters;
  very different files fall back to page-by-page
- ✅ Batch actions: saved workflows (recognise text, rotate, compress, watermark, page numbers, remove hidden information,
  flatten, PDF/A, password) run on chosen files or a folder (with subfolders) on the desktop; results next to each file
  or in a folder, with a name suffix; per-file results and errors; stop after the current file; passwords are asked for
  each run and never saved
- ✅ Accessibility checker: tags, language, title display, real text (scans), Unicode mapping, image alt text,
  headings, reading order (manual), tab order, link descriptions, form field tooltips, bookmarks for long documents,
  security blocking assistive technology, contrast (manual). Fixes: language, title, tab order, field tooltips from
  field names, link descriptions, bookmarks from headings, alt text for tagged images; one undo step
- ✅ Table extraction: finds tables from aligned rows and columns (wrapped cells and tight spacing handled), preview,
  export to an Excel workbook (one sheet per table, numbers as numbers, bold header) or CSV files
- ✅ Optional assistant (off by default): summarise, ask questions with clickable page citations, follow-ups, and
  suggest form values from the document (each with its source page, applied one by one). Claude via your own
  Anthropic API key (Claude Opus 5.5, streamed) or a local model through Ollama. Every request shows the pages,
  size and destination and waits for Send; nothing runs in the background
- 🟡 Not yet: tagging untagged PDFs (needs the source application), editing reading order, comparing scanned
  documents (recognise text first), structured outputs from local models depend on the model, the API key is stored
  in the app's settings rather than Windows Credential Manager
