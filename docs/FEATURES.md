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
- ⬜ Multiple tabs; single-instance (opening a 2nd file adds a tab); recent files with thumbnails on the start screen
- ⬜ Snap Layouts on the custom maximize button
- ⬜ Cancellable priority render queue; tiled rendering for very high zoom
- ⬜ Zoom field with typed value and presets; marquee zoom; rotate view; two-page/book layouts
- ⬜ Sidebar: thumbnails, outline/bookmarks, attachments, layers, annotations list
- ⬜ Full-text search (regex, case, whole word), hit list, highlights
- ⬜ Text selection and copy; area copy as image
- ⬜ Links, back/forward history
- ⬜ Presentation mode, read aloud, night/sepia reading modes
- ⬜ Print (ranges, scaling, booklet, N-up)
- ⬜ Document properties

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
