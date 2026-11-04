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
