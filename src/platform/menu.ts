// The Mac menu bar (Tauri's menu API). The layout comes from src/ui/appMenu.ts; this file only builds it.
import type { MenuSection } from "../ui/appMenu";

/**
 * Builds the menu bar and makes it the app's menu. `onCommand` runs a command by id; "Quit" closes the window, which
 * asks about unsaved changes like the close button does, and then quits.
 */
export async function setAppMenu(sections: MenuSection[], onCommand: (id: string) => void, version: string | null): Promise<void> {
  const { Menu, MenuItem, PredefinedMenuItem, Submenu } = await import("@tauri-apps/api/menu");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const submenus = [];
  let windowsMenu = null;
  for (const section of sections) {
    const items = [];
    for (const e of section.entries) {
      if (e.kind === "separator") items.push(await PredefinedMenuItem.new({ item: "Separator" }));
      else if (e.kind === "native") items.push(await PredefinedMenuItem.new({ item: e.item }));
      else if (e.kind === "about") items.push(await PredefinedMenuItem.new({ item: { About: { name: "PDForge", ...(version ? { version } : {}) } }, text: "About PDForge" }));
      else if (e.kind === "quit") items.push(await MenuItem.new({ text: "Quit PDForge", accelerator: "CmdOrCtrl+Q", action: () => void getCurrentWindow().close() }));
      else items.push(await MenuItem.new({ id: `cmd:${e.id}`, text: e.label, ...(e.accelerator ? { accelerator: e.accelerator } : {}), action: () => onCommand(e.id) }));
    }
    const sub = await Submenu.new({ text: section.title, items });
    if (section.windowsMenu) windowsMenu = sub;
    submenus.push(sub);
  }
  const menu = await Menu.new({ items: submenus });
  await menu.setAsAppMenu();
  await windowsMenu?.setAsWindowsMenuForNSApp();
}
