// Shortcuts and menus on both systems. Every command and shortcut is checked for Windows and for the Mac, so a new
// command that doesn't fit one of them fails here.
import { describe, expect, it } from "vitest";
import { menuAccelerator, menuLayout } from "../../src/ui/appMenu";
import { COMMANDS, defaultKeys, displayCombo, effectiveKeymap, shortcutLabel } from "../../src/ui/commands";

/** macOS's own shortcuts ("Ctrl" here is ⌘), which a Mac default must never use. */
const MAC_SYSTEM = ["Ctrl+H", "Ctrl+M", "Ctrl+Q", "Ctrl+`", "Ctrl+Space", "Ctrl+,", "Ctrl+Alt+H", "Ctrl+Tab"];

describe("shortcut labels", () => {
  it("stay as they were on Windows", () => {
    expect(displayCombo("Ctrl+Plus", false)).toBe("Ctrl++");
    expect(displayCombo("Ctrl+Shift+Minus", false)).toBe("Ctrl+Shift+−");
    expect(displayCombo("Alt+ArrowLeft", false)).toBe("Alt+←");
    expect(displayCombo("Ctrl+\\", false)).toBe("Ctrl+\\");
    expect(displayCombo("F3", false)).toBe("F3");
    expect(shortcutLabel("file.save", false)).toBe("Ctrl+S");
    expect(shortcutLabel("nav.goto", false)).toBe("Ctrl+G");
    expect(shortcutLabel("edit.redo", false)).toBe("Ctrl+Y");
  });

  it("use Mac symbols in Apple's order on a Mac", () => {
    expect(displayCombo("Ctrl+Shift+S", true)).toBe("⇧⌘S");
    expect(displayCombo("Ctrl+Plus", true)).toBe("⌘+");
    expect(displayCombo("Ctrl+Alt+G", true)).toBe("⌥⌘G");
    expect(displayCombo("Shift+F3", true)).toBe("⇧F3");
    expect(displayCombo("Ctrl+Tab", true)).toBe("⌃⇥");
    expect(displayCombo("Ctrl+Shift+Tab", true)).toBe("⌃⇧⇥");
    expect(shortcutLabel("nav.goto", true)).toBe("⌥⌘G");
    expect(shortcutLabel("edit.redo", true)).toBe("⇧⌘Z");
  });
});

describe("default shortcuts", () => {
  for (const mac of [false, true]) {
    const system = mac ? "Mac" : "Windows";
    it(`has no duplicates on ${system}`, () => {
      const seen = new Map<string, string>();
      for (const c of COMMANDS)
        for (const k of defaultKeys(c, mac)) {
          expect(seen.get(k), `${k} is used by ${seen.get(k)} and ${c.id} on ${system}`).toBeUndefined();
          seen.set(k, c.id);
        }
    });
  }

  it("leave macOS's own shortcuts alone on a Mac", () => {
    for (const c of COMMANDS) for (const k of defaultKeys(c, true)) if (c.id !== "window.nextTab") expect(MAC_SYSTEM, `${c.id} uses ${k}`).not.toContain(k);
  });

  it("don't take ⌥← and ⌥→ on a Mac, which move by word while typing", () => {
    const keys = effectiveKeymap({}, true);
    for (const [id, combos] of Object.entries(keys)) expect(combos.filter((k) => /^Alt\+Arrow/.test(k)), id).toEqual([]);
  });

  it("are the same as before on Windows", () => {
    const keys = effectiveKeymap({}, false);
    for (const c of COMMANDS) expect(keys[c.id]).toEqual(c.keys);
  });
});

describe("Mac menu bar", () => {
  const layout = menuLayout(effectiveKeymap({}, true));
  const commands = layout.flatMap((s) => s.entries).flatMap((e) => (e.kind === "command" ? [e] : []));

  it("lists every command once, except the Windows-only one and those macOS's Edit menu covers", () => {
    const ids = commands.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const missing = COMMANDS.map((c) => c.id).filter((id) => !ids.includes(id));
    expect(missing.sort()).toEqual(["edit.copy", "edit.selectAll", "window.defaultApp"]);
  });

  it("has the usual Mac menus, with Quit and the window list", () => {
    expect(layout.map((s) => s.title)).toEqual(["PDForge", "File", "Edit", "View", "Go", "Tools", "Window"]);
    expect(layout[0].entries.some((e) => e.kind === "quit")).toBe(true);
    expect(layout.find((s) => s.windowsMenu)?.title).toBe("Window");
    const edit = layout.find((s) => s.title === "Edit")!.entries;
    for (const item of ["Cut", "Copy", "Paste", "SelectAll"]) expect(edit).toContainEqual({ kind: "native", item });
  });

  it("shows shortcuts that a menu can take", () => {
    const acc = (id: string) => commands.find((e) => e.id === id)?.accelerator;
    expect(acc("file.save")).toBe("CmdOrCtrl+S");
    expect(acc("file.saveAs")).toBe("CmdOrCtrl+Shift+S");
    expect(acc("view.zoomIn")).toBe("CmdOrCtrl+Equal");
    expect(acc("nav.findNext")).toBe("CmdOrCtrl+G");
    expect(acc("window.split")).toBe("CmdOrCtrl+\\");
    // Single keys would stop working in text fields; Ctrl+Tab is the real Control key.
    expect(acc("tool.hand")).toBeUndefined();
    expect(acc("nav.first")).toBeUndefined();
    expect(acc("window.nextTab")).toBeUndefined();
  });

  it("follows rebound shortcuts", () => {
    const rebound = menuLayout(effectiveKeymap({ "file.print": ["Ctrl+Shift+P"] }, true));
    const print = rebound.flatMap((s) => s.entries).find((e) => e.kind === "command" && e.id === "file.print");
    expect(print).toMatchObject({ accelerator: "CmdOrCtrl+Shift+P" });
  });

  it("turns every default shortcut into an accelerator or leaves it out", () => {
    for (const c of COMMANDS)
      for (const k of defaultKeys(c, true)) {
        const a = menuAccelerator(k);
        if (a) expect(a).toMatch(/^((CmdOrCtrl|Alt|Shift)\+)*([A-Z0-9]|F\d+|Equal|Minus|\\|\[|\]|Arrow\w+)$/);
      }
  });
});
