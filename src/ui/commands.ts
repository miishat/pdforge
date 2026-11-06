// Every action that can go in the command palette or on a keyboard shortcut. Shortcuts are
// stored as normalised strings ("Ctrl+Shift+S", "F3", "Alt+ArrowLeft", "V") and can be rebound;
// user overrides live in settings and replace the defaults per command.
import { load, save } from "./settings";

export type CommandCategory = "File" | "View" | "Navigate" | "Tools" | "Mode" | "Edit" | "Protect" | "Window";

export interface CommandDef {
  id: string;
  label: string;
  category: CommandCategory;
  /** Default shortcuts (empty: none, still in the palette). */
  keys: string[];
  /** Works while typing in a text field (shortcuts with Ctrl, like Save). */
  inInput?: boolean;
  /** Extra words the palette matches on. */
  keywords?: string;
}

export const COMMANDS: CommandDef[] = [
  // File
  { id: "file.open", label: "Open…", category: "File", keys: ["Ctrl+O"], inInput: true },
  { id: "file.create", label: "Create a PDF from files…", category: "File", keys: [], keywords: "convert word excel powerpoint html image" },
  { id: "file.save", label: "Save", category: "File", keys: ["Ctrl+S"], inInput: true },
  { id: "file.saveAs", label: "Save as…", category: "File", keys: ["Ctrl+Shift+S"], inInput: true },
  { id: "file.print", label: "Print…", category: "File", keys: ["Ctrl+P"], inInput: true },
  { id: "file.properties", label: "Document properties", category: "File", keys: ["Ctrl+D"], inInput: true },
  { id: "file.close", label: "Close tab", category: "File", keys: ["Ctrl+W", "Ctrl+F4"], inInput: true },
  { id: "file.export", label: "Export as Word, Markdown, HTML, text or images…", category: "File", keys: [], keywords: "docx convert" },
  { id: "file.exportComments", label: "Export comments…", category: "File", keys: [], keywords: "xfdf" },
  { id: "file.importComments", label: "Import comments…", category: "File", keys: [], keywords: "xfdf" },
  { id: "file.batch", label: "Batch actions…", category: "File", keys: [], keywords: "workflow folder automate" },
  { id: "file.compare", label: "Compare with another PDF…", category: "File", keys: [], keywords: "diff differences" },
  // Window
  { id: "window.palette", label: "Command palette", category: "Window", keys: ["Ctrl+K"], inInput: true },
  { id: "window.nextTab", label: "Next tab", category: "Window", keys: ["Ctrl+Tab"], inInput: true },
  { id: "window.prevTab", label: "Previous tab", category: "Window", keys: ["Ctrl+Shift+Tab"], inInput: true },
  { id: "window.split", label: "Split view: two documents side by side", category: "Window", keys: ["Ctrl+\\"], keywords: "side by side" },
  { id: "window.syncScroll", label: "Split view: synchronise scrolling", category: "Window", keys: [] },
  { id: "window.checkUpdates", label: "Check for updates…", category: "Window", keys: [], keywords: "update upgrade new version release download install" },
  { id: "window.autoUpdates", label: "Turn automatic update checks on or off", category: "Window", keys: [], keywords: "update upgrade settings" },
  { id: "window.shortcuts", label: "Keyboard shortcuts…", category: "Window", keys: [], keywords: "keymap rebind vim settings" },
  { id: "window.clearSearchData", label: "Clear saved search data", category: "Window", keys: [], keywords: "search index cache text privacy disk space delete" },
  { id: "window.defaultApp", label: "Make PDForge the default PDF app…", category: "Window", keys: [], keywords: "default app file association open pdf windows settings" },
  { id: "window.assistant", label: "Assistant…", category: "Window", keys: [], keywords: "ai summarize ask question claude" },
  // View
  { id: "view.zoomIn", label: "Zoom in", category: "View", keys: ["Ctrl+Plus"], inInput: true },
  { id: "view.zoomOut", label: "Zoom out", category: "View", keys: ["Ctrl+Minus"], inInput: true },
  { id: "view.fitPage", label: "Fit page", category: "View", keys: ["Ctrl+0"], inInput: true },
  { id: "view.actualSize", label: "Actual size", category: "View", keys: ["Ctrl+1"], inInput: true },
  { id: "view.fitWidth", label: "Fit width", category: "View", keys: ["Ctrl+2"], inInput: true },
  { id: "view.rotateCw", label: "Rotate view clockwise", category: "View", keys: ["Ctrl+Shift+Plus"], inInput: true },
  { id: "view.rotateCcw", label: "Rotate view counterclockwise", category: "View", keys: ["Ctrl+Shift+Minus"], inInput: true },
  { id: "view.sidebar", label: "Show or hide the sidebar", category: "View", keys: ["F4"], inInput: true },
  { id: "view.present", label: "Presentation", category: "View", keys: ["Ctrl+L", "F5"], inInput: true },
  { id: "view.readAloud", label: "Read aloud", category: "View", keys: ["Ctrl+Shift+Y"], inInput: true },
  // Navigate
  { id: "nav.find", label: "Find in document", category: "Navigate", keys: ["Ctrl+F"], inInput: true, keywords: "search" },
  { id: "nav.findBookmark", label: "Find a bookmark or chapter", category: "Navigate", keys: ["Ctrl+Shift+B"], inInput: true, keywords: "search outline contents toc section heading" },
  { id: "nav.findNext", label: "Find next", category: "Navigate", keys: ["F3"], inInput: true },
  { id: "nav.findPrev", label: "Find previous", category: "Navigate", keys: ["Shift+F3"], inInput: true },
  { id: "nav.goto", label: "Go to page…", category: "Navigate", keys: ["Ctrl+G"], inInput: true },
  { id: "nav.first", label: "First page", category: "Navigate", keys: ["Home"] },
  { id: "nav.last", label: "Last page", category: "Navigate", keys: ["End"] },
  { id: "nav.back", label: "Back", category: "Navigate", keys: ["Alt+ArrowLeft"], inInput: true },
  { id: "nav.forward", label: "Forward", category: "Navigate", keys: ["Alt+ArrowRight"], inInput: true },
  // Tools
  { id: "tool.select", label: "Select tool", category: "Tools", keys: ["V"] },
  { id: "tool.hand", label: "Hand tool", category: "Tools", keys: ["H"] },
  { id: "tool.marquee", label: "Marquee zoom tool", category: "Tools", keys: ["Z"] },
  { id: "tool.snapshot", label: "Snapshot tool", category: "Tools", keys: ["G"] },
  // Edit
  { id: "edit.undo", label: "Undo", category: "Edit", keys: ["Ctrl+Z"] },
  { id: "edit.redo", label: "Redo", category: "Edit", keys: ["Ctrl+Y", "Ctrl+Shift+Z"] },
  { id: "edit.copy", label: "Copy selected text", category: "Edit", keys: ["Ctrl+C"] },
  { id: "edit.selectAll", label: "Select all", category: "Edit", keys: ["Ctrl+A"] },
  { id: "edit.flatten", label: "Flatten comments and fields…", category: "Edit", keys: [] },
  { id: "edit.tables", label: "Extract tables to CSV or Excel…", category: "Edit", keys: [], keywords: "xlsx spreadsheet" },
  // Modes
  { id: "mode.read", label: "Read mode", category: "Mode", keys: ["Ctrl+Shift+1"], inInput: true },
  { id: "mode.comment", label: "Comment mode", category: "Mode", keys: ["Ctrl+Shift+2"], inInput: true },
  { id: "mode.fill", label: "Fill & Sign mode", category: "Mode", keys: ["Ctrl+Shift+3"], inInput: true },
  { id: "mode.organize", label: "Organize mode", category: "Mode", keys: ["Ctrl+Shift+4"], inInput: true },
  { id: "mode.edit", label: "Edit mode", category: "Mode", keys: ["Ctrl+Shift+5"], inInput: true },
  { id: "mode.protect", label: "Protect mode", category: "Mode", keys: ["Ctrl+Shift+6"], inInput: true },
  // Protect & convert
  { id: "protect.security", label: "Security: passwords and permissions…", category: "Protect", keys: [], keywords: "encrypt password lock" },
  { id: "protect.ocr", label: "Recognise text (OCR)…", category: "Protect", keys: [], keywords: "scan ocr" },
  { id: "protect.compress", label: "Compress…", category: "Protect", keys: [], keywords: "reduce size optimize" },
  { id: "protect.pdfa", label: "PDF/A archiving…", category: "Protect", keys: [] },
  { id: "protect.repair", label: "Repair…", category: "Protect", keys: [] },
  { id: "protect.a11y", label: "Check accessibility…", category: "Protect", keys: [], keywords: "screen reader alt text tags" },
];

export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/** Vim-style navigation, when switched on (single keys, never while typing). */
export const VIM_KEYS: { key: string; label: string }[] = [
  { key: "j / k", label: "Scroll down / up" },
  { key: "d / u", label: "Half a screen down / up" },
  { key: "h / l", label: "Previous / next page" },
  { key: "gg / G", label: "First / last page" },
  { key: "/", label: "Find" },
  { key: "n / N", label: "Next / previous result" },
];

const SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", _: "Minus", "+": "Plus", "|": "\\",
};

/** A keyboard event as a shortcut string, or null for a bare modifier press. */
export function comboOf(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return null;
  let key: string;
  // Physical keys for digits and symbols, so Ctrl+Shift+1 doesn't arrive as "!".
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === "Equal" || e.key === "+" || e.key === "=") key = "Plus";
  else if (e.code === "Minus" || e.key === "-") key = "Minus";
  else if (e.code === "Backslash") key = "\\";
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.key.length === 1) key = SHIFTED[e.key] ?? e.key.toUpperCase();
  else key = e.key === " " ? "Space" : e.key;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** "Ctrl+Plus" → "Ctrl++", for display. */
export function displayCombo(c: string): string {
  return c.replace(/Plus$/, "+").replace(/Minus$/, "−").replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("ArrowUp", "↑").replace("ArrowDown", "↓");
}

export type Keymap = Record<string, string[]>;

const KEYMAP_KEY = "keymap";

export function loadOverrides(): Keymap {
  const v = load<Keymap>(KEYMAP_KEY, {});
  return v && typeof v === "object" ? v : {};
}

export function saveOverrides(k: Keymap) {
  save(KEYMAP_KEY, k);
}

/** The effective shortcuts for every command. */
export function effectiveKeymap(overrides: Keymap): Keymap {
  const out: Keymap = {};
  for (const c of COMMANDS) out[c.id] = overrides[c.id] ?? c.keys;
  return out;
}

/** Combo → command id. With duplicate bindings, the first command in the list wins. */
export function reverseKeymap(keymap: Keymap): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of COMMANDS) for (const k of keymap[c.id] ?? []) if (!m.has(k)) m.set(k, c.id);
  return m;
}

/** Other commands already using a combo. */
export function conflicts(keymap: Keymap, combo: string, except: string): string[] {
  return COMMANDS.filter((c) => c.id !== except && (keymap[c.id] ?? []).includes(combo)).map((c) => c.id);
}

/** Shortcuts the system or WebView2 reserve; binding them would never fire or would break things. */
export const RESERVED = new Set(["Alt+F4", "Ctrl+Alt+Delete", "Alt+Tab", "Ctrl+Shift+Escape", "Escape", "Tab", "Shift+Tab", "Enter", "Space"]);

/** Fuzzy match for the palette: every query word must start a word of the label (or keywords), or appear in it. */
export function matchScore(c: CommandDef, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const hay = `${c.label} ${c.category} ${c.keywords ?? ""}`.toLowerCase();
  let score = 0;
  for (const word of q.split(/\s+/)) {
    const i = hay.indexOf(word);
    if (i < 0) return 0;
    const wordStart = i === 0 || /[\s(/:]/.test(hay[i - 1]);
    score += wordStart ? 3 : 1;
    if (c.label.toLowerCase().startsWith(word)) score += 2;
  }
  return score;
}

export function loadVim(): boolean {
  return load("vimKeys", false);
}

export function saveVim(on: boolean) {
  save("vimKeys", on);
}
