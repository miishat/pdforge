// Which operating system the app runs on. Kept free of Tauri imports so UI logic that depends on it stays testable.

/** True on macOS (the Mac app, or a browser on a Mac). Windows, Linux and the end-to-end tests are false. */
export const isMac = typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform || "");
