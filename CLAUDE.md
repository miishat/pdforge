# PDForge: notes for Claude

- The brief is `docs/PROMPT.md`; follow its phases, Design Direction and Quality Bar. Progress lives in `docs/FEATURES.md`;
  update it at the end of each phase. Architecture: `PLAN.md`.
- Target: Windows 10/11 only for now. Personal, non-commercial use; MuPDF (AGPL) is fine.
- Engine code in `src/core` must stay DOM-free (runs in a worker and in Node tests). Tauri-specific calls only in `src/platform`.
- All colors, sizes and motion come from `src/styles/tokens.css`. Avoid the "generic AI look" listed in the brief.
- Before calling work done: `npm run typecheck`, `npm test`, `npm run test:e2e`, plus light/dark screenshots of changed screens.
- In the cloud container, Playwright needs `PW_CHROMIUM=/opt/pw-browsers/chromium`. The Windows installer is built by CI only.
- MuPDF gotchas: never call `needsPassword()` after authenticating (it drops the authentication); stream reads and
  writes need the indirect object, not `.resolve()`; save options `objstms`/`clean` modify the document (use a copy).
- OCR assets (Tesseract worker, cores, English model) are served by the Vite plugin in `vite.config.ts`, not committed.
- Releases: `npm run release -- X.Y.Z`, then `git push origin main`; a new version on main makes
  `.github/workflows/release.yml` tag, build and publish it (tag pushes are blocked from cloud sessions). It signs with the `TAURI_SIGNING_PRIVATE_KEY` secret (public key in `tauri.conf.json`). Never commit the private key.
  Everyday CI builds use `src-tauri/tauri.ci.conf.json`, which turns off updater signing.
- Windows-only Rust (`src-tauri/src/shell.rs`) can't be built here (no MSVC tools). Type-check it by copying its `imp`
  module into a scratch crate that depends only on the same `windows` version, with `cargo check --target
  x86_64-pc-windows-msvc`; CI's Windows build is the real check.
