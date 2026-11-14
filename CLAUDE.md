# PDForge: notes for Claude

- The brief is `docs/PROMPT.md`; follow its phases, Design Direction and Quality Bar. Progress lives in `docs/FEATURES.md`;
  update it at the end of each phase. Architecture: `PLAN.md`.
- Targets: Windows 10/11, and macOS 12+ on Apple silicon (in progress, `docs/MAC_PLAN.md`). Personal, non-commercial
  use; MuPDF (AGPL) is fine.
- One codebase for both systems. Every feature is built once and works on both; keep them in step:
  - System-specific code only in `src/platform` (`isMac`), `#[cfg]` blocks in `src-tauri`, `tauri.macos.conf.json`
    and `capabilities/macos.json`. Don't change what Windows shows or does when adding Mac behaviour.
  - New actions go in `COMMANDS` (`src/ui/commands.ts`): that gives the palette, rebindable shortcuts and the Mac menu
    bar (`src/ui/appMenu.ts`) in one place. Give `macKeys` where a Windows default clashes with a Mac convention.
  - Never write shortcut text like "Ctrl+S" in the UI: use `shortcutLabel(id)` (⌘S on a Mac) or `displayCombo`.
  - Messages that name the system or its settings must say the right one on each.
- Engine code in `src/core` must stay DOM-free (runs in a worker and in Node tests). Tauri-specific calls only in `src/platform`.
- All colors, sizes and motion come from `src/styles/tokens.css`. Avoid the "generic AI look" listed in the brief.
- Before calling work done: `npm run typecheck`, `npm test`, `npm run test:e2e`, plus light/dark screenshots of changed screens.
  Rust changes: `npm run check:rust` (checks Windows, macOS and Linux here). CI also runs every end-to-end test in
  WebKit (`npm run test:e2e:webkit`, the Mac app's engine) and builds both apps; WebKit can't be downloaded in the cloud
  container, so check that CI job instead (`gh run list`, `gh workflow run windows.yml --ref <branch>` for a branch).
- In the cloud container, Playwright needs `PW_CHROMIUM=/opt/pw-browsers/chromium`. The Windows installer and the Mac
  app (`.dmg`) are built by CI only.
- MuPDF gotchas: never call `needsPassword()` after authenticating (it drops the authentication); stream reads and
  writes need the indirect object, not `.resolve()`; save options `objstms`/`clean` modify the document (use a copy).
- OCR assets (Tesseract worker, cores, English model) are served by the Vite plugin in `vite.config.ts`, not committed.
- Releases: `npm run release -- X.Y.Z`, then `git push origin main`; a new version on main makes
  `.github/workflows/release.yml` tag, build and publish it (tag pushes are blocked from cloud sessions). It signs with the `TAURI_SIGNING_PRIVATE_KEY` secret (public key in `tauri.conf.json`). Never commit the private key.
  Everyday CI builds use `src-tauri/tauri.ci.conf.json`, which turns off updater signing.
- Windows- and Mac-only Rust can't be built here (no MSVC or Apple tools), but `npm run check:rust` type-checks it;
  CI's builds are the real check.
