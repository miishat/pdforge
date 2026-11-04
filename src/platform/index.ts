// Platform layer: the only place that knows whether we run inside Tauri (the real app)
// or a plain browser (development and end-to-end tests).
import { invoke } from "@tauri-apps/api/core";

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface PickedFile {
  name: string;
  /** Absolute path on disk; null in the browser. */
  path: string | null;
  bytes: Uint8Array;
}

export async function readPath(path: string): Promise<PickedFile> {
  const buf = await invoke<ArrayBuffer>("read_file", { path });
  return { name: baseName(path), path, bytes: new Uint8Array(buf) };
}

export async function pickFiles(filter: { name: string; extensions: string[] }): Promise<PickedFile[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const paths = await open({ multiple: true, filters: [filter] });
    if (!paths) return [];
    return Promise.all((Array.isArray(paths) ? paths : [paths]).map(readPath));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = filter.extensions.map((e) => `.${e}`).join(",");
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(fromBrowserFile)));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function pickPdfs(): Promise<PickedFile[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const paths = await open({ multiple: true, filters: [{ name: "PDF documents", extensions: ["pdf"] }] });
    if (!paths) return [];
    return Promise.all((Array.isArray(paths) ? paths : [paths]).map(readPath));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "application/pdf,.pdf";
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(fromBrowserFile)));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function fromBrowserFile(file: File): Promise<PickedFile> {
  return { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Files passed on the command line, e.g. when Windows opens a .pdf with PDForge. */
export async function launchFiles(): Promise<string[]> {
  if (!isDesktop) return [];
  return invoke<string[]>("launch_files");
}

/** Files Windows asks the already-running app to open (second launch, single-instance). */
export async function onOpenFiles(cb: (paths: string[]) => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string[]>("open-files", (e) => cb(e.payload));
}

/** Asks where to save and writes the bytes. Returns false if the user cancelled. */
export async function saveBytes(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = /\.([a-z0-9]+)$/i.exec(suggestedName)?.[1];
    const path = await save({ defaultPath: suggestedName, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [] });
    if (!path) return false;
    await invoke("write_file", bytes, { headers: { path: encodeURIComponent(path) } });
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** Overwrites a file on disk (atomically: temp file + rename). Desktop only. */
export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  if (!isDesktop) throw new Error("Saving in place needs the desktop app.");
  await invoke("write_file", bytes, { headers: { path: encodeURIComponent(path) } });
}

/** Asks for a location and saves. Returns the chosen path, "" in the browser (downloaded), or null if cancelled. */
export async function saveAs(suggestedName: string, bytes: Uint8Array, filter = { name: "PDF document", extensions: ["pdf"] }): Promise<string | null> {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: suggestedName, filters: [filter] });
    if (!path) return null;
    await writePath(path, bytes);
    return path;
  }
  await saveBytes(suggestedName, bytes);
  return "";
}

/**
 * Saves several files. On the desktop the user picks a folder; in the browser each file downloads.
 * Returns the number saved, or null if cancelled.
 */
export async function saveFiles(files: { name: string; bytes: Uint8Array }[]): Promise<number | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "Choose a folder for the files" });
    if (typeof dir !== "string") return null;
    const sep = dir.includes("\\") ? "\\" : "/";
    for (const f of files) await writePath(`${dir.replace(/[\\/]$/, "")}${sep}${f.name}`, f.bytes);
    return files.length;
  }
  for (const f of files) await saveBytes(f.name, f.bytes);
  return files.length;
}

/** Picks one file of any of the given extensions and returns it. */
export async function pickFile(filter: { name: string; extensions: string[] }): Promise<PickedFile | null> {
  const any = filter.extensions.includes("*");
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, filters: any ? [] : [filter] });
    return typeof path === "string" ? readPath(path) : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (!any) input.accept = filter.extensions.map((e) => `.${e}`).join(",");
    input.onchange = async () => resolve(input.files?.[0] ? await fromBrowserFile(input.files[0]) : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

let cachedUser: string | null = null;
/** The Windows account name, used as the default comment author. */
export async function userName(): Promise<string> {
  if (cachedUser) return cachedUser;
  cachedUser = isDesktop ? await invoke<string>("user_name").catch(() => "Me") : "Me";
  return cachedUser;
}

export interface RecoveryMeta {
  name: string;
  path: string | null;
  savedAt: number;
}

export async function recoverySave(key: string, meta: RecoveryMeta, bytes: Uint8Array): Promise<void> {
  if (!isDesktop) return;
  await invoke("recovery_save", bytes, { headers: { key: encodeURIComponent(key), meta: encodeURIComponent(JSON.stringify(meta)) } });
}

export async function recoveryList(): Promise<{ key: string; meta: RecoveryMeta }[]> {
  if (!isDesktop) return [];
  const raw = await invoke<{ key: string; meta: string }[]>("recovery_list").catch(() => []);
  return raw.flatMap((r) => {
    try {
      return [{ key: r.key, meta: JSON.parse(r.meta) as RecoveryMeta }];
    } catch {
      return [];
    }
  });
}

export async function recoveryRead(key: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("recovery_read", { key }));
}

export async function recoveryClear(key: string): Promise<void> {
  if (isDesktop) await invoke("recovery_clear", { key }).catch(() => {});
}

/** Lets the app veto closing the window (to ask about unsaved changes). Returns an unsubscribe function. */
export async function onWindowCloseRequested(handler: () => Promise<boolean>): Promise<() => void> {
  if (!isDesktop) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  return win.onCloseRequested(async (event) => {
    event.preventDefault();
    if (await handler()) await win.destroy();
  });
}

/** Opens a web or mail link in the default app. Callers must confirm with the user first. */
export async function openExternal(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url)) throw new Error("Only web and email links can be opened.");
  if (isDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export async function setFullscreen(on: boolean): Promise<void> {
  try {
    if (isDesktop) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(on);
    } else if (on && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else if (!on && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch {
    /* full screen refused: presentation still works in the window */
  }
}

export async function windowAction(action: "minimize" | "toggleMaximize" | "close"): Promise<void> {
  if (!isDesktop) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()[action]();
}

export async function setWindowTitle(title: string): Promise<void> {
  if (isDesktop) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } else {
    document.title = title;
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export async function copyPng(bytes: Uint8Array): Promise<void> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Picks a folder and lists its files with these extensions (desktop), or picks several files
 * (browser, where folders can't be read). Returns paths to read later on the desktop.
 */
export async function pickFolderFiles(extensions: string[], recursive: boolean): Promise<{ folder: string | null; files: PickedFileRef[] } | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "Choose a folder of files" });
    if (typeof dir !== "string") return null;
    const { invoke } = await import("@tauri-apps/api/core");
    const paths = await invoke<string[]>("list_files", { dir, extensions, recursive });
    return { folder: dir, files: paths.map((p) => ({ name: baseName(p), path: p, read: () => readPath(p).then((f) => f.bytes) })) };
  }
  const files = await pickFiles({ name: "Files", extensions });
  return { folder: null, files: files.map((f) => ({ name: f.name, path: null, read: async () => f.bytes })) };
}

/** A file chosen for later reading (batch inputs are read one at a time to save memory). */
export interface PickedFileRef {
  name: string;
  path: string | null;
  read: () => Promise<Uint8Array>;
}

/** Picks files (desktop: paths, read later). */
export async function pickFileRefs(extensions: string[]): Promise<PickedFileRef[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const paths = await open({ multiple: true, filters: [{ name: "Files", extensions }] });
    if (!paths) return [];
    return (Array.isArray(paths) ? paths : [paths]).map((p) => ({ name: baseName(p), path: p, read: () => readPath(p).then((f) => f.bytes) }));
  }
  const files = await pickFiles({ name: "Files", extensions });
  return files.map((f) => ({ name: f.name, path: null, read: async () => f.bytes }));
}

/** Picks an output folder (desktop). In the browser there is none: results download. */
export async function pickOutputFolder(): Promise<string | null> {
  if (!isDesktop) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title: "Choose where to save the results" });
  return typeof dir === "string" ? dir : null;
}

/** Writes a file into a folder (desktop) or downloads it (browser). */
export async function writeInto(folder: string | null, name: string, bytes: Uint8Array): Promise<string> {
  if (isDesktop && folder) {
    const sep = folder.includes("\\") ? "\\" : "/";
    const path = `${folder.replace(/[\\/]$/, "")}${sep}${name}`;
    await writePath(path, bytes);
    return path;
  }
  await saveBytes(name, bytes);
  return name;
}
