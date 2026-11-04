# PDForge

A fast, private, offline PDF reader and editor for Windows: a personal replacement for Adobe Acrobat.

> Status: **Phase 0** (foundation). It opens and reads PDFs. See [docs/FEATURES.md](docs/FEATURES.md) for what works.

## Install on Windows

1. Open the repository's **Actions** tab on GitHub, pick the latest green **Build** run, and download
   **PDForge-windows-installer**.
2. Unzip it and run `PDForge_x.y.z_x64-setup.exe` (or the `.msi`).
3. The installer isn't code-signed, so Windows SmartScreen may warn you. Choose **More info → Run anyway**.

### Make PDForge your default PDF app
**Settings → Apps → Default apps →** type `.pdf` **→** choose **PDForge**.
Or right-click any PDF **→ Open with → Choose another app → PDForge → Always**.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Open a file | Ctrl+O |
| Close the document | Ctrl+W |
| Zoom in / out | Ctrl++ / Ctrl+− (or Ctrl+mouse wheel) |
| Fit page / actual size / fit width | Ctrl+0 / Ctrl+1 / Ctrl+2 |

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
