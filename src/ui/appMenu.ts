// The Mac menu bar, built from the same command list as the command palette and keyboard shortcuts, so a new
// command shows up in the menus without extra work. Only the Mac app has a menu bar; Windows keeps its own UI.
import { COMMANDS, type CommandCategory, type Keymap } from "./commands";

/** Items macOS provides itself (they act on text fields, the window or the app). */
export type NativeItem = "Cut" | "Copy" | "Paste" | "SelectAll" | "Minimize" | "Maximize" | "Fullscreen" | "Hide" | "HideOthers" | "ShowAll" | "Services" | "BringAllToFront";

export type MenuEntry =
  | { kind: "command"; id: string; label: string; accelerator?: string }
  | { kind: "native"; item: NativeItem }
  | { kind: "about" }
  | { kind: "quit" }
  | { kind: "separator" };

export interface MenuSection {
  title: string;
  entries: MenuEntry[];
  /** macOS adds its window list to this menu. */
  windowsMenu?: boolean;
}

/** In the app menu (named after the app) rather than in Window. */
const APP_MENU_COMMANDS = ["window.checkUpdates", "window.autoUpdates", "window.shortcuts"];
/** Windows-only, or done by macOS's own menu items. */
const LEFT_OUT = new Set(["window.defaultApp"]);
/** In Edit, where they also act on text fields; see `EDIT_ROUTED`. */
const EDIT_OWN = new Set(["edit.undo", "edit.redo", "edit.copy", "edit.selectAll"]);
/** Undo and Redo work on a text field while typing in one, and on the document otherwise (App.tsx). */
export const EDIT_ROUTED = new Set(["edit.undo", "edit.redo"]);

const MENU_OF: Record<CommandCategory, string> = {
  File: "File",
  Edit: "Edit",
  View: "View",
  Mode: "View",
  Navigate: "Go",
  Tools: "Tools",
  Protect: "Tools",
  Window: "Window",
};

/**
 * A shortcut as a menu accelerator ("Ctrl+Shift+S" → "CmdOrCtrl+Shift+S"). Null for keys a menu must not take:
 * single keys without ⌘, ⌥ or a function key (they'd stop working in text fields), and Ctrl+Tab, which stays the
 * real Control key and is left to the page.
 */
export function menuAccelerator(combo: string): string | null {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const mods = parts;
  if (key === "Tab") return null;
  if (!mods.includes("Ctrl") && !mods.includes("Alt") && !/^F\d+$/.test(key)) return null;
  const name = key === "Plus" ? "Equal" : key === "Minus" ? "Minus" : key;
  return [...mods.map((m) => (m === "Ctrl" ? "CmdOrCtrl" : m)), name].join("+");
}

function commandEntry(id: string, label: string, keymap: Keymap): MenuEntry {
  const first = (keymap[id] ?? []).map(menuAccelerator).find((a): a is string => !!a);
  return { kind: "command", id, label, ...(first ? { accelerator: first } : {}) };
}

/** The whole menu bar, for the current keymap (so rebound shortcuts show in the menus too). */
export function menuLayout(keymap: Keymap): MenuSection[] {
  const sep: MenuEntry = { kind: "separator" };
  const byMenu = new Map<string, MenuEntry[]>();
  let lastCategory: CommandCategory | null = null;
  for (const c of COMMANDS) {
    if (LEFT_OUT.has(c.id) || APP_MENU_COMMANDS.includes(c.id) || EDIT_OWN.has(c.id)) continue;
    const menu = MENU_OF[c.category];
    const list = byMenu.get(menu) ?? [];
    // A line between categories that share a menu (View and Mode, Tools and Protect).
    if (list.length && lastCategory && lastCategory !== c.category && MENU_OF[lastCategory] === menu) list.push(sep);
    list.push(commandEntry(c.id, c.label, keymap));
    byMenu.set(menu, list);
    lastCategory = c.category;
  }
  const label = (id: string) => COMMANDS.find((c) => c.id === id)!.label;
  return [
    {
      title: "PDForge",
      entries: [
        { kind: "about" },
        sep,
        ...APP_MENU_COMMANDS.map((id) => commandEntry(id, label(id), keymap)),
        sep,
        { kind: "native", item: "Services" },
        sep,
        { kind: "native", item: "Hide" },
        { kind: "native", item: "HideOthers" },
        { kind: "native", item: "ShowAll" },
        sep,
        { kind: "quit" },
      ],
    },
    { title: "File", entries: byMenu.get("File") ?? [] },
    {
      title: "Edit",
      entries: [
        commandEntry("edit.undo", "Undo", keymap),
        commandEntry("edit.redo", "Redo", keymap),
        sep,
        { kind: "native", item: "Cut" },
        { kind: "native", item: "Copy" },
        { kind: "native", item: "Paste" },
        { kind: "native", item: "SelectAll" },
        ...(byMenu.get("Edit")?.length ? [sep, ...byMenu.get("Edit")!] : []),
      ],
    },
    { title: "View", entries: [...(byMenu.get("View") ?? []), sep, { kind: "native", item: "Fullscreen" }] },
    { title: "Go", entries: byMenu.get("Go") ?? [] },
    { title: "Tools", entries: byMenu.get("Tools") ?? [] },
    {
      title: "Window",
      windowsMenu: true,
      entries: [{ kind: "native", item: "Minimize" }, { kind: "native", item: "Maximize" }, sep, ...(byMenu.get("Window") ?? []), sep, { kind: "native", item: "BringAllToFront" }],
    },
  ];
}
