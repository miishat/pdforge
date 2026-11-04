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

export async function pickPdf(): Promise<PickedFile | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, filters: [{ name: "PDF documents", extensions: ["pdf"] }] });
    return typeof path === "string" ? readPath(path) : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await fromBrowserFile(file) : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function fromBrowserFile(file: File): Promise<PickedFile> {
  return { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** A file passed on the command line, e.g. when Windows opens a .pdf with PDForge. */
export async function launchFile(): Promise<PickedFile | null> {
  if (!isDesktop) return null;
  const path = await invoke<string | null>("launch_file");
  return path ? readPath(path) : null;
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

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
