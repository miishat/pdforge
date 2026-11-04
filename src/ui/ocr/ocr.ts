// Text recognition in the app: Tesseract runs in its own worker, loaded from /tesseract/ (no CDN).
// English ships with PDForge; other languages are downloaded once, on request, and kept in the
// same IndexedDB cache Tesseract reads from, so recognition itself never touches the network.
import { createWorker } from "tesseract.js";
import { engine } from "../../core/client";
import type { OcrPage } from "../../core/ocr";

const BASE = `${import.meta.env.BASE_URL}tesseract/`;
const CDN = "https://cdn.jsdelivr.net/npm/@tesseract.js-data";
const CACHE_PREFIX = "pdforge-ocr";

export interface OcrLanguage {
  code: string;
  label: string;
}

export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: "eng", label: "English" },
  { code: "deu", label: "German" },
  { code: "fra", label: "French" },
  { code: "spa", label: "Spanish" },
  { code: "ita", label: "Italian" },
  { code: "por", label: "Portuguese" },
  { code: "nld", label: "Dutch" },
  { code: "pol", label: "Polish" },
  { code: "ces", label: "Czech" },
  { code: "swe", label: "Swedish" },
  { code: "dan", label: "Danish" },
  { code: "nor", label: "Norwegian" },
  { code: "fin", label: "Finnish" },
  { code: "hun", label: "Hungarian" },
  { code: "ron", label: "Romanian" },
  { code: "tur", label: "Turkish" },
  { code: "ell", label: "Greek" },
  { code: "rus", label: "Russian" },
  { code: "ukr", label: "Ukrainian" },
  { code: "ara", label: "Arabic" },
  { code: "heb", label: "Hebrew" },
  { code: "hin", label: "Hindi" },
  { code: "ben", label: "Bengali" },
  { code: "tha", label: "Thai" },
  { code: "vie", label: "Vietnamese" },
  { code: "ind", label: "Indonesian" },
  { code: "chi_sim", label: "Chinese (Simplified)" },
  { code: "chi_tra", label: "Chinese (Traditional)" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
];

// ---- Language cache (IndexedDB, in the layout Tesseract's idb-keyval cache uses) ----

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("keyval-store");
    req.onupgradeneeded = () => req.result.createObjectStore("keyval");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheOp<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(d.transaction("keyval", mode).objectStore("keyval"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

const key = (code: string) => `${CACHE_PREFIX}/${code}.traineddata`;

export async function installedLanguages(): Promise<Set<string>> {
  const keys = await cacheOp("readonly", (s) => s.getAllKeys()).catch(() => [] as IDBValidKey[]);
  const set = new Set<string>(["eng"]);
  for (const k of keys) {
    const m = typeof k === "string" ? /^pdforge-ocr\/(.+)\.traineddata$/.exec(k) : null;
    if (m) set.add(m[1]);
  }
  return set;
}

/** Puts a language's model in the cache: English from the app, others from the jsDelivr CDN. */
export async function installLanguage(code: string, signal?: AbortSignal): Promise<void> {
  if (!OCR_LANGUAGES.some((l) => l.code === code)) throw new Error(`Unknown language "${code}".`);
  const existing = await cacheOp("readonly", (s) => s.get(key(code))).catch(() => undefined);
  if (existing) return;
  const url = code === "eng" ? `${BASE}lang/eng.traineddata.gz` : `${CDN}/${code}/4.0.0_best_int/${code}.traineddata.gz`;
  let resp: Response;
  try {
    resp = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error("The language couldn't be downloaded. Check your internet connection and try again.");
  }
  if (!resp.ok) throw new Error(`The language couldn't be downloaded (${resp.status}).`);
  const data = new Uint8Array(await resp.arrayBuffer());
  // The model arrives gzipped, or already unpacked when the server sent it with gzip encoding.
  // Tesseract accepts both; an HTML error page or a truncated file is a broken download.
  const gz = data[0] === 0x1f && data[1] === 0x8b;
  if (!gz && (data.length < 100_000 || data[0] === 0x3c)) throw new Error("The downloaded language file is damaged.");
  await cacheOp("readwrite", (s) => s.put(data, key(code)));
}

export async function removeLanguage(code: string): Promise<void> {
  if (code === "eng") return;
  await cacheOp("readwrite", (s) => s.delete(key(code)));
}

// ---- Recognition ----

export interface OcrProgress {
  /** 0-based position in the list of pages being recognised. */
  done: number;
  total: number;
  page: number;
  /** Progress within the current page, 0–1. */
  pageProgress: number;
}

export interface OcrRun {
  docId: number;
  pages: number[];
  languages: string[];
  deskew: boolean;
  /** Recognise pages that already have text too. */
  force: boolean;
  dpi?: number;
}

export interface OcrOutcome {
  recognised: number[];
  skipped: number[];
  /** Average Tesseract confidence (0–100) across recognised pages. */
  confidence: number;
}

/**
 * Recognises the pages and adds their text layers as one undoable step.
 * Cancelling (via `signal`) stops after the current page and changes nothing.
 */
export async function recognisePages(run: OcrRun, onProgress: (p: OcrProgress) => void, signal: AbortSignal): Promise<OcrOutcome> {
  for (const code of run.languages) await installLanguage(code, signal);
  const { todo, skipped } = await engine().call("ocrCandidates", run.docId, run.pages, run.force);
  if (!todo.length) return { recognised: [], skipped, confidence: 0 };
  let current = { done: 0, page: todo[0] };
  const worker = await createWorker(run.languages, 1, {
    workerPath: `${BASE}worker.min.js`,
    corePath: BASE,
    langPath: `${BASE}lang`,
    cachePath: CACHE_PREFIX,
    cacheMethod: "readOnly",
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === "recognizing text") onProgress({ ...current, total: todo.length, pageProgress: m.progress });
    },
  });
  const results: OcrPage[] = [];
  let confidence = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      current = { done: i, page: todo[i] };
      onProgress({ ...current, total: todo.length, pageProgress: 0 });
      const png = await engine().call("ocrImage", run.docId, todo[i], run.dpi ?? 300);
      const { data } = await worker.recognize(png as unknown as Blob, { rotateAuto: run.deskew, pdfTextOnly: true, pdfTitle: "PDForge OCR" }, { pdf: true, text: false, blocks: false });
      if (!data.pdf) throw new Error("Text recognition returned no result.");
      results.push({ page: todo[i], pdf: new Uint8Array(data.pdf), rotateRadians: data.rotateRadians ?? 0, deskew: run.deskew });
      confidence += data.confidence;
    }
  } finally {
    void worker.terminate();
  }
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  await engine().call("addOcrLayers", run.docId, results);
  onProgress({ done: todo.length, total: todo.length, page: todo[todo.length - 1], pageProgress: 1 });
  return { recognised: todo, skipped, confidence: Math.round(confidence / todo.length) };
}
