import { engine } from "../../core/client";
import type { TextWorkerReply, TextWorkerRequest } from "../../core/textWorker";

/** Pages handed to a helper at a time. */
const CHUNK = 48;
/** Below this many unread pages, the main engine alone is quick enough. */
const MIN_PAGES = 300;
/** Each helper holds its own copy of the file; keep the copies together under this. */
const MEMORY_BUDGET = 800_000_000;

/**
 * Reads the text of a large document in helper workers, in parallel, and hands it to the engine,
 * so a first search over thousands of pages takes seconds rather than minutes.
 * Pages are read in search order: from the page the search started on to the end, then from the start.
 */
export class TextIndexJob {
  active = true;
  /** True once every page has been read (rather than the job being stopped early). */
  complete = false;
  private ended!: () => void;
  /** Resolves when the job ends, for any reason. */
  readonly finished = new Promise<void>((r) => (this.ended = r));
  private readonly workers: Worker[] = [];
  private readonly queue: [number, number][] = [];
  private busy = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly docId: number,
    private readonly revision: number,
    bytes: Uint8Array,
    pageCount: number,
    startPage: number,
    helpers: number,
  ) {
    for (let p = startPage; p < pageCount; p += CHUNK) this.queue.push([p, Math.min(pageCount, p + CHUNK)]);
    for (let p = 0; p < startPage; p += CHUNK) this.queue.push([p, Math.min(startPage, p + CHUNK)]);
    for (let i = 0; i < helpers; i++) {
      const w = new Worker(new URL("../../core/textWorker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<TextWorkerReply>) => void this.onReply(w, e.data);
      w.onerror = () => this.stop();
      const copy = bytes.slice();
      w.postMessage({ kind: "open", bytes: copy } satisfies TextWorkerRequest, [copy.buffer]);
      this.workers.push(w);
    }
  }

  /** Resolves when more text has arrived, or the job has ended. */
  changed(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    for (const w of this.workers) w.terminate();
    if (jobs.get(this.docId) === this) jobs.delete(this.docId);
    this.notify();
    this.ended();
  }

  private notify() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  private next(w: Worker) {
    const chunk = this.queue.shift();
    if (!chunk) {
      if (this.busy === 0) {
        this.complete = true;
        this.stop();
      }
      return;
    }
    this.busy++;
    w.postMessage({ kind: "read", from: chunk[0], to: chunk[1] } satisfies TextWorkerRequest);
  }

  private async onReply(w: Worker, r: TextWorkerReply) {
    if (!this.active) return;
    if (r.kind === "error") return this.stop();
    if (r.kind === "opened") return this.next(w);
    this.busy--;
    let ok = false;
    try {
      ok = await engine().call("seedText", this.docId, this.revision, r.from, r.texts);
    } catch {
      ok = false;
    }
    // Refused: the document changed since the helpers opened it. The engine reads what's left itself.
    if (!ok) return this.stop();
    this.notify();
    this.next(w);
  }
}

const jobs = new Map<number, TextIndexJob>();

/** Starts (or returns the running) parallel text reading for a document, when it's worth it and possible. */
export async function ensureTextIndex(docId: number, pageCount: number, startPage: number): Promise<TextIndexJob | null> {
  const running = jobs.get(docId);
  if (running?.active) return running;
  if (pageCount < MIN_PAGES || typeof Worker === "undefined") return null;
  const src = await engine().call("textSource", docId);
  if (!src || src.missing < MIN_PAGES) return null;
  const cores = navigator.hardwareConcurrency || 4;
  const helpers = Math.min(Math.max(1, cores - 2), 6, Math.floor(MEMORY_BUDGET / Math.max(1, src.bytes.length)));
  if (helpers < 1) return null;
  if (jobs.get(docId)?.active) return jobs.get(docId)!;
  const job = new TextIndexJob(docId, src.revision, src.bytes, pageCount, startPage, helpers);
  jobs.set(docId, job);
  return job;
}

export function stopTextIndex(docId: number) {
  jobs.get(docId)?.stop();
}
