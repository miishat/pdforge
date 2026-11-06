import { engine } from "../../core/client";
import { packPlainText } from "../../core/plainStore";
import type { PackReply, PackRequest } from "../../core/packWorker";
import { savedTextStore, type SavedTextStore } from "../../platform";

/** Only documents with more pages than this get their text saved; smaller ones are quick to read anyway. */
export const SAVE_ABOVE_PAGES = 500;
/** All saved text together stays under this; the least recently used goes first. */
export const SAVED_TEXT_BUDGET = 200 * 1024 * 1024;

/** Removes the least recently used saved text until the total fits the budget. `keep` is never removed. */
export async function trimSavedText(store: SavedTextStore, budget = SAVED_TEXT_BUDGET, keep?: string): Promise<void> {
  const entries = (await store.list()).sort((a, b) => a.used - b.used);
  let total = entries.reduce((n, e) => n + e.size, 0);
  for (const e of entries) {
    if (total <= budget) break;
    if (e.key === keep) continue;
    await store.remove(e.key);
    total -= e.size;
  }
}

/** Compresses page text in a short-lived worker, so neither the engine nor the UI stalls (inline without workers). */
function packInWorker(texts: string[]): Promise<Uint8Array | null> {
  if (typeof Worker === "undefined") return packPlainText(texts);
  return new Promise((resolve) => {
    const w = new Worker(new URL("../../core/packWorker.ts", import.meta.url), { type: "module" });
    const done = (data: Uint8Array | null) => (w.terminate(), resolve(data));
    w.onmessage = (e: MessageEvent<PackReply>) => done(e.data.kind === "packed" ? e.data.data : null);
    w.onerror = () => done(null);
    w.postMessage({ kind: "pack", texts } satisfies PackRequest);
  });
}

/** Files whose text is on disk already (saved or loaded this session), by fingerprint. */
const onDisk = new Set<string>();
/** Documents already looked up, so each is checked once. */
const lookedUp = new Map<number, string>();

/**
 * Before a large document's first search: loads its page text saved in an earlier session, if there is any.
 * True when loaded, so searching needn't read the pages.
 */
export async function loadSavedText(docId: number, pageCount: number, store = savedTextStore): Promise<boolean> {
  if (pageCount <= SAVE_ABOVE_PAGES) return false;
  const key = await engine().call("textFingerprint", docId);
  if (!key || lookedUp.get(docId) === key) return false;
  lookedUp.set(docId, key);
  const data = await store.read(key).catch(() => null);
  if (!data) return false;
  const result = await engine().call("importPlainText", docId, data).catch(() => "changed" as const);
  if (result === "loaded") onDisk.add(key);
  else if (result === "rejected") await store.remove(key).catch(() => {});
  return result === "loaded";
}

/** After every page of a large document has been read: saves the text for next time. True when saved. */
export async function saveText(docId: number, pageCount: number, store = savedTextStore, budget = SAVED_TEXT_BUDGET): Promise<boolean> {
  if (pageCount <= SAVE_ABOVE_PAGES) return false;
  const key = await engine().call("textFingerprint", docId);
  if (!key || onDisk.has(key)) return false;
  const texts = await engine().call("allPlainText", docId);
  if (!texts || onDisk.has(key)) return false;
  const data = await packInWorker(texts);
  if (!data || data.length > budget || onDisk.has(key)) return false;
  onDisk.add(key);
  try {
    await store.write(key, data);
    await trimSavedText(store, budget, key);
    return true;
  } catch {
    onDisk.delete(key);
    return false;
  }
}

/** Deletes all saved search text. */
export async function clearSavedText(store = savedTextStore): Promise<void> {
  await store.clear();
  onDisk.clear();
  lookedUp.clear();
}
