# PDForge

A fast, private, offline PDF reader and editor for Windows: a personal replacement for Adobe Acrobat.

> Status: **Phase 3**: reading, comments, forms and signatures, plus page organising, editing and redaction. See [docs/FEATURES.md](docs/FEATURES.md) for what works.

## Install on Windows

1. Open the repository's **Actions** tab on GitHub, pick the latest green **Build** run, and download
   **PDForge-windows-installer**.
2. Unzip it and run `PDForge_x.y.z_x64-setup.exe` (or the `.msi`).
3. The installer isn't code-signed, so Windows SmartScreen may warn you. Choose **More info → Run anyway**.

### Make PDForge your default PDF app
**Settings → Apps → Default apps →** type `.pdf` **→** choose **PDForge**.
Or right-click any PDF **→ Open with → Choose another app → PDForge → Always**.

## Keyboard shortcuts

Most match Acrobat, so your habits carry over.

| Action | Shortcut |
| --- | --- |
| Open / close / next tab | Ctrl+O / Ctrl+W / Ctrl+Tab |
| Find, next, previous | Ctrl+F, F3 (or Enter), Shift+F3 |
| Copy selection / select all | Ctrl+C / Ctrl+A |
| Zoom in / out | Ctrl++ / Ctrl+− (or Ctrl+mouse wheel) |
| Fit page / actual size / fit width | Ctrl+0 / Ctrl+1 / Ctrl+2 |
| Rotate view | Ctrl+Shift++ / Ctrl+Shift+− |
| Go to page | Ctrl+G |
| First / last page | Home / End |
| Back / forward (after following a link) | Alt+← / Alt+→ |
| Sidebar | F4 |
| Select / hand / snapshot / marquee zoom | V / H (or hold Space) / G / Z |
| Presentation | Ctrl+L or F5 |
| Read aloud | Ctrl+Shift+Y |
| Print / properties | Ctrl+P / Ctrl+D |
| Save / save as | Ctrl+S / Ctrl+Shift+S |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Read / Comment / Fill & Sign / Organize / Edit / Protect mode | Ctrl+Shift+1 / 2 / 3 / 4 / 5 / 6 |
| Organize: select all / delete pages | Ctrl+A / Del |
| Delete / nudge selected comment | Del / arrow keys (Shift for 10 pt) |
| Finish a polygon | Double-click or Enter |

## Development

Requires Node 22 and Rust (stable). On Windows, Tauri also needs the WebView2 runtime (preinstalled on Windows 11).

```bash
npm install
npm run dev          # UI in the browser at http://localhost:1420
npm run tauri dev    # the real desktop app
npm test             # unit tests
npm run test:e2e     # end-to-end tests (Playwright, Chromium)
npm run tauri build  # Windows installer in src-tauri/target/release/bundle
```

Architecture: [PLAN.md](PLAN.md). Original brief: [docs/PROMPT.md](docs/PROMPT.md).

## License

PDForge uses [MuPDF](https://mupdf.com) (© Artifex Software), which is licensed under the GNU AGPL v3.
PDForge is therefore also AGPL-3.0-or-later. It's built for personal use; if you ever distribute it,
the AGPL requires you to share the source code.
