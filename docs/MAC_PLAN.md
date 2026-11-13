# PDForge on macOS: plan

Status: planned, not started (decisions made, see the end). Estimate: 2–3 working days, plus one or two rounds of fixes after testing on a real Mac.

## Where things stand

Most of PDForge already runs on a Mac unchanged:

- The PDF engine is MuPDF compiled to WebAssembly, which runs the same in every browser engine. All the reading,
  editing, forms, signing, redaction, OCR, compare and conversion code in `src/core` is portable.
- The Rust side (`src-tauri/src/lib.rs`) is plain file reading and writing, using the right app-data folder on each
  system (`~/Library/Application Support/com.miishat.pdforge` on a Mac).
- The Windows-only parts (`src-tauri/src/shell.rs`: Snap Layouts, the jump list, default-app registration) already
  do nothing on other systems, and the UI hides what depends on them.
- Shortcuts already accept ⌘ wherever they accept Ctrl (`comboOf` in `src/ui/commands.ts` treats both as "Ctrl").

What doesn't fit a Mac yet falls into six areas below.

## 1. Window and menu bar (about half a day)

- **Native window buttons.** The window is frameless (`decorations: false`) with Windows-style minimize, maximize
  and close buttons drawn on the right. On a Mac, add `src-tauri/tauri.macos.conf.json` (Tauri merges it over
  `tauri.conf.json` on macOS only) with the native title bar hidden but its red/yellow/green buttons kept
  (`titleBarStyle: "Overlay"`, `hiddenTitle: true`, `decorations: true`). That brings back rounded corners, the
  window shadow, full screen and macOS's own tiling menu on the green button.
- **Title bar layout.** On a Mac, hide our window buttons and leave room on the left (about 78 px) for the native
  ones; the tabs move right to make space. The bar stays draggable.
- **Menu bar.** macOS apps need an app menu: PDForge (About, Check for updates, Quit), File, Edit, View and
  Window. The Edit menu is not optional: without it, ⌘C, ⌘V and ⌘A don't work in text fields. Menu items run the
  existing commands from `src/ui/commands.ts`, so there's one list of actions.
- **Quitting with unsaved changes.** ⌘Q quits the app without closing the window first, so the current "unsaved
  changes" prompt (`onWindowCloseRequested`) would be skipped. Catch the quit request in Rust
  (`RunEvent::ExitRequested`), hold it, and ask the UI the same way closing the window does.
- **Closing the window** quits the app (simpler than the Mac habit of staying open with no window; can change later).

## 2. Opening files from Finder (about half a day)

- **Double-clicking a PDF.** On a Mac the file arrives as an "open documents" event (`RunEvent::Opened`), not as a
  command-line argument, so today PDForge would start but not open the file. Handle that event both at startup
  (queue the files for `launch_files`) and while running (send `open-files`, as the single-instance plugin does on
  Windows).
- **"Open with" and default app.** `fileAssociations` in `tauri.conf.json` already becomes the right Info.plist
  entries, so PDForge appears in Finder's "Open With" list. To make it the default: Finder → Get Info on any PDF →
  Open with → PDForge → Change All. The in-app offer to become the default stays Windows-only for now.
- **Recent files in the Dock.** Optional: add opened files to macOS's recent documents, so right-clicking the Dock
  icon lists them (the Mac version of the Windows jump list).
- **Drag and drop** onto the window already goes through Tauri and works the same.

## 3. Shortcuts and labels (about half a day)

- **Labels.** Show ⌘, ⌥ and ⇧ instead of Ctrl, Alt and Shift: in the command palette, the shortcuts dialog, button
  tooltips and the start screen. `displayCombo` in `src/ui/commands.ts` does the conversion; about 70 hard-coded
  "Ctrl+…" strings in tooltips need to go through it.
- **Clashes with macOS.** ⌘H (hide app), ⌘M (minimize), ⌘Q (quit), ⌘` (next window) and ⌘Tab belong to macOS;
  check the keymap doesn't use any of them with ⌘. Ctrl+Tab for the next tab keeps working with the real Ctrl key.
- **Pinch to zoom.** Zooming listens for Ctrl+wheel, which is what a pinch sends in Chromium. Safari's engine sends
  its own gesture events instead. Handle those too, keeping the point under the fingers fixed.

## 4. Safari's engine instead of Chromium (about a day, the uncertain part)

On Windows the app runs in WebView2 (Chromium); all 79 end-to-end tests run in Chromium. On a Mac it runs in
WKWebView, the engine behind Safari. Things to check and fix:

- **Printing.** `window.print()` (`src/ui/doc/print.ts`) has been unreliable in WKWebView. Use Tauri's own print
  call for the webview on macOS.
- **Previews.** Shrinking a drawn page into a preview uses `createImageBitmap` with resize options, which Safari
  may ignore, leaving full-size "previews" that fill the 64 MB preview cache quickly. Fall back to drawing it smaller
  on a canvas.
- **Read aloud** (`speechSynthesis`): check it exists in WKWebView and lists the system voices.
- **Saved search text** uses `CompressionStream`, which needs Safari 16.4 or later. Minimum macOS is 12
  (Monterey); where `CompressionStream` is missing (an older Safari), saving search text is skipped rather than
  failing, and searching still works.
- **Scrollbars.** macOS hides scrollbars until you scroll; check that our styled scrollbars stay visible and
  draggable, since dragging the scrollbar is a main way to move through long files.
- **Retina screens.** Pages are drawn at twice the pixels per side (four times the memory), so the 128 MB page cache
  holds fewer pages. Check how it feels; raise the budgets on Mac if needed.
- **Fonts.** The interface asks for Segoe UI and falls back to the system font (San Francisco). Check spacing and
  sizes in both light and dark themes.

**How to find problems before you install anything:** add a WebKit run of the end-to-end tests to CI (Playwright
includes a WebKit build close to Safari's). Fix what fails there first; most engine differences show up this way.

## 5. Building, releasing and updating (about half a day)

- **CI build.** Add a macOS job to `.github/workflows/windows.yml`, so every push also builds the Mac app.
- **Release.** Turn `.github/workflows/release.yml` into a matrix: the existing Windows job plus a macOS job. Both
  upload to the same GitHub release, and `latest.json` gets a Mac entry next to the Windows one, so the in-app updater
  works on both from the same release. The updater uses the same signing key (`TAURI_SIGNING_PRIVATE_KEY`).
- **Download.** A `.dmg` to drag into Applications.
- **Which Mac.** Apple Silicon only (`aarch64-apple-darwin`), built on GitHub's Apple Silicon runners. Intel can be
  added later as a second target.

## 6. Getting past Gatekeeper (decided: free)

macOS checks that downloaded apps come from a known developer. Two options; **we're going with the free one**:

- **Free (chosen).** The app isn't notarized. The first time you open it, macOS refuses. On macOS 15 and later: System
  Settings → Privacy & Security → "Open Anyway". On earlier versions: right-click the app → Open. Once only; updates
  installed by PDForge itself don't trigger it again.
- **$99 a year** (Apple Developer Program). The app is signed and notarized in CI and opens like any other app. Needs
  four more GitHub secrets (certificate, password, Apple ID app password, team ID).

## Testing on your Mac

After a CI build, install it and check, in about 15 minutes:

1. It opens, and the window buttons, rounded corners, full screen and green-button tiling work.
2. Double-click a PDF in Finder (with PDForge closed, and again with it open).
3. Scroll, drag the scrollbar through a long file, jump pages, pinch to zoom, zoom out to many pages.
4. ⌘O, ⌘S, ⌘K, ⌘F, ⌘C/⌘V in a text field, ⌘W; menus work and show the right shortcuts.
5. Edit something, then ⌘Q: the "unsaved changes" prompt appears.
6. Print a mixed portrait/landscape file.
7. Read aloud, search a large file twice (the second search is quick), sign, fill a form, OCR a scan.
8. Light and dark mode.
9. Check for updates from the start screen.

## Order of work

1. WebKit end-to-end run in CI; fix what it finds (section 4).
2. Window, menus and quitting (1); opening files (2); shortcuts and labels (3).
3. macOS build in CI (5), then you test it on your Mac (checklist above).
4. One round of fixes from that; then add the Mac to the release workflow and publish.

## Decisions

- **Mac:** Apple Silicon only.
- **Gatekeeper:** free; "Open Anyway" in System Settings once, the first time.
- **Minimum macOS:** 12 (Monterey). Every Apple Silicon Mac can run 12 or later; to check yours: Apple menu → About
  This Mac. If it's on 11 (Big Sur), update it, or tell me and the minimum can go down to 11.
