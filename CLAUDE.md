# PDForge: notes for Claude

- The brief is `docs/PROMPT.md`; follow its phases, Design Direction and Quality Bar. Progress lives in `docs/FEATURES.md`;
  update it at the end of each phase. Architecture: `PLAN.md`.
- Target: Windows 10/11 only for now. Personal, non-commercial use; MuPDF (AGPL) is fine.
- Engine code in `src/core` must stay DOM-free (runs in a worker and in Node tests). Tauri-specific calls only in `src/platform`.
- All colors, sizes and motion come from `src/styles/tokens.css`. Avoid the "generic AI look" listed in the brief.
- Before calling work done: `npm run typecheck`, `npm test`, `npm run test:e2e`, plus light/dark screenshots of changed screens.
- In the cloud container, Playwright needs `PW_CHROMIUM=/opt/pw-browsers/chromium`. The Windows installer is built by CI only.
