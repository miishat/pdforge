// Promise-based client for the engine worker, plus a prioritized, cancellable render queue.
import type { Args, Envelope, Op, Reply, Result } from "./protocol";
import type { RenderRequest } from "./types";

export class EngineClientError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

interface QueuedRender {
  req: RenderRequest;
  priority: number;
  signal?: AbortSignal;
  resolve: (v: Result<"render">) => void;
  reject: (e: Error) => void;
  /** A helper failed to draw it: only the main engine tries again. */
  mainOnly?: boolean;
}

/** Renders are queued in the UI thread so stale requests can be dropped before reaching the worker. */
const MAX_RENDERS_IN_FLIGHT = 2;
/** Each file copied to the helpers counts against this (per helper), least recently drawn dropped first. */
const HELPER_MEMORY_BUDGET = 600 * 1024 * 1024;

/**
 * Engine operations that never change what a page draws. Any other call may (an edit, undo, save, layer switch...),
 * so the helpers stop drawing that document until the main engine confirms their copy still matches.
 */
const DRAW_SAFE_OPS = new Set<string>([
  "info", "render", "renderImage", "textLayer", "pageText", "plainText", "textSource", "seedText", "textFingerprint",
  "allPlainText", "importPlainText", "firstUnread", "find", "search", "links", "outline", "attachments", "attachment",
  "layers", "annotations", "widgets", "formSummary", "signatures", "exportXfdf", "textLines", "images",
  "redactionPresets", "findForRedaction", "redactionMarkCount", "markKinds", "changeStamp", "editState", "fileSize",
  "properties", "compareText", "compareVisual", "findTables", "tablesToXlsx", "checkAccessibility", "exportText",
  "exportMarkdown", "exportHtml", "exportDocx", "exportImages", "checkPdfA", "ocrCandidates", "drawingSource",
]);

/** How many drawing helpers to start: two, unless the computer has too few cores to run them alongside the rest. */
function helperCount(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(0, Math.min(2, cores - 2));
}

/** A second (or third) engine that only draws pages, from its own copy of unchanged files. */
class DrawingHelper {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Main docId -> this helper's copy: its id here, which file version it is, its size, when it was last drawn. */
  readonly docs = new Map<number, { id: Promise<number>; ready: boolean; stamp: number; size: number; used: number }>();
  busy = false;
  dead = false;

  constructor(private readonly onDead: () => void) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.value);
      else p.reject(new EngineClientError(e.data.message, e.data.code));
    };
    this.worker.onerror = () => this.die();
  }

  private send(op: string, args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
    if (this.dead) return Promise.reject(new EngineClientError("The drawing helper stopped."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args } as Envelope, transfer);
    });
  }

  /** Takes a copy of the file (ownership of `bytes` passes to the helper). */
  load(docId: number, stamp: number, bytes: Uint8Array) {
    this.unload(docId);
    const size = bytes.length;
    const id = this.send("openForDrawing", [bytes], [bytes.buffer]) as Promise<number>;
    const entry = { id, ready: false, stamp, size, used: Date.now() };
    this.docs.set(docId, entry);
    id.then(
      () => {
        if (this.docs.get(docId) === entry) entry.ready = true;
      },
      () => {
        if (this.docs.get(docId) === entry) this.docs.delete(docId);
      },
    );
    // Keep the copies under budget, dropping the least recently drawn.
    let total = [...this.docs.values()].reduce((n, d) => n + d.size, 0);
    for (const [k, d] of [...this.docs].sort((a, b) => a[1].used - b[1].used)) {
      if (total <= HELPER_MEMORY_BUDGET || k === docId) continue;
      total -= d.size;
      this.unload(k);
    }
  }

  unload(docId: number) {
    const d = this.docs.get(docId);
    if (!d) return;
    this.docs.delete(docId);
    void d.id.then((id) => this.send("close", [id])).catch(() => {});
  }

  canDraw(docId: number, stamp: number): boolean {
    const d = this.docs.get(docId);
    return !this.dead && !this.busy && !!d && d.ready && d.stamp === stamp;
  }

  async render(req: RenderRequest): Promise<Result<"render">> {
    const d = this.docs.get(req.docId)!;
    d.used = Date.now();
    const id = await d.id;
    return (await this.send("render", [{ ...req, docId: id }])) as Result<"render">;
  }

  private die() {
    if (this.dead) return;
    this.dead = true;
    this.worker.terminate();
    const err = new EngineClientError("The drawing helper stopped.");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.docs.clear();
    this.onDead();
  }
}

/** Per document: whether the helpers may draw it right now, and which file version they hold. */
interface DrawingShare {
  /** The version the helpers hold, if confirmed to match what's open; null while unconfirmed or unshareable. */
  stamp: number | null;
  /** Bumped by every check; a reply to an older check is ignored. */
  check: number;
  /** The last version handed to the helpers (kept across edits, so undoing back to it needs no new copy). */
  copied: number | null;
  timer?: ReturnType<typeof setTimeout>;
}

export class EngineClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: QueuedRender[] = [];
  private inFlight = 0;
  private helpers: DrawingHelper[] | null = null;
  private shares = new Map<number, DrawingShare>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.value);
      else p.reject(new EngineClientError(e.data.message, e.data.code));
    };
    // If the worker itself crashes, fail every pending call instead of hanging forever.
    this.worker.onerror = (e) => {
      const err = new EngineClientError(`The PDF engine stopped unexpectedly (${e.message || "unknown error"}).`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  call<K extends Op>(op: K, ...args: Args<K>): Promise<Result<K>> {
    const id = this.nextId++;
    const transfer: Transferable[] = [];
    if (op === "open" && args[0] instanceof Uint8Array) transfer.push(args[0].buffer);
    // A call that may change how a document draws stops the helpers drawing it until it's checked again.
    const docId = typeof args[0] === "number" ? args[0] : null;
    const share = docId !== null && !DRAW_SAFE_OPS.has(op) ? this.shares.get(docId) : undefined;
    if (share) {
      share.stamp = null;
      share.check++; // A check already on its way was answered before this call: its answer no longer counts.
    }
    const result = new Promise<Result<K>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args } as Envelope, transfer);
    });
    if (docId !== null && op === "close") this.stopSharing(docId);
    else if (share) {
      const recheck = () => this.scheduleCheck(docId!);
      result.then(recheck, recheck);
    }
    return result;
  }

  /**
   * Lets the drawing helpers draw this document's pages too, from their own copy of the file, whenever what's open
   * is exactly the file (checked again after every change). Does nothing on computers with few cores.
   */
  shareForDrawing(docId: number) {
    if (this.shares.has(docId)) return;
    this.helpers ??= Array.from({ length: helperCount() }, () => new DrawingHelper(() => this.pump()));
    if (!this.helpers.length) return;
    this.shares.set(docId, { stamp: null, check: 0, copied: null });
    this.scheduleCheck(docId, 0);
  }

  /** Draws by the helpers are allowed for this document (for tests and diagnostics). */
  sharedForDrawing(docId: number): boolean {
    return this.shares.get(docId)?.stamp != null;
  }

  private stopSharing(docId: number) {
    const share = this.shares.get(docId);
    if (!share) return;
    clearTimeout(share.timer);
    this.shares.delete(docId);
    for (const h of this.helpers ?? []) h.unload(docId);
  }

  /** Asks the main engine (after a short pause, so a burst of edits makes one check) whether the copy still matches. */
  private scheduleCheck(docId: number, delay = 60) {
    const share = this.shares.get(docId);
    if (!share) return;
    clearTimeout(share.timer);
    share.timer = setTimeout(() => void this.checkShare(docId), delay);
  }

  private async checkShare(docId: number) {
    const share = this.shares.get(docId);
    if (!share) return;
    const check = ++share.check;
    let src;
    try {
      src = await this.call("drawingSource", docId, share.copied);
    } catch {
      return;
    }
    // Something else was sent since (or the document closed): that call's own check decides.
    if (this.shares.get(docId) !== share || share.check !== check) return;
    if (!src.shareable) {
      share.stamp = null;
      return;
    }
    if (src.bytes) {
      const helpers = (this.helpers ?? []).filter((h) => !h.dead);
      helpers.forEach((h, i) => h.load(docId, src.stamp, i === helpers.length - 1 ? src.bytes! : src.bytes!.slice()));
      share.copied = src.stamp;
    }
    share.stamp = src.stamp;
    // Copies open in the background; drawing moves to the helpers once they're ready.
    for (const h of this.helpers ?? []) {
      const d = h.docs.get(docId);
      if (d && !d.ready) void d.id.then(() => this.pump(), () => {});
    }
    this.pump();
  }

  /**
   * Queues a page render. Lower priority numbers render first (use distance from the visible page).
   * Aborting the signal drops the request if it hasn't started yet.
   */
  render(req: RenderRequest, priority: number, signal?: AbortSignal): Promise<Result<"render">> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new CancelledError());
      this.queue.push({ req, priority, signal, resolve, reject });
      this.pump();
    });
  }

  /** An idle helper that can draw this job right now, if any. */
  private helperFor(job: QueuedRender): DrawingHelper | undefined {
    if (job.mainOnly) return undefined;
    const stamp = this.shares.get(job.req.docId)?.stamp;
    if (stamp == null) return undefined;
    return this.helpers?.find((h) => h.canDraw(job.req.docId, stamp));
  }

  private pump() {
    for (;;) {
      this.queue = this.queue.filter((q) => {
        if (q.signal?.aborted) q.reject(new CancelledError());
        return !q.signal?.aborted;
      });
      if (!this.queue.length) return;
      // The most urgent job goes to a free helper if one can draw it, otherwise to the main engine; when the main
      // engine is full, free helpers take the most urgent jobs they can draw.
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[best].priority) best = i;
      let helper = this.helperFor(this.queue[best]);
      if (!helper && this.inFlight >= MAX_RENDERS_IN_FLIGHT) {
        best = -1;
        for (let i = 0; i < this.queue.length; i++) {
          if ((best < 0 || this.queue[i].priority < this.queue[best].priority) && this.helperFor(this.queue[i])) best = i;
        }
        if (best < 0) return;
        helper = this.helperFor(this.queue[best]);
      }
      const job = this.queue.splice(best, 1)[0];
      if (helper) this.runOnHelper(job, helper);
      else this.runOnMain(job);
    }
  }

  private finish(job: QueuedRender, r: Result<"render">) {
    if (job.signal?.aborted) {
      r.bitmap.close();
      job.reject(new CancelledError());
    } else job.resolve(r);
  }

  private runOnMain(job: QueuedRender) {
    this.inFlight++;
    this.call("render", job.req)
      .then((r) => this.finish(job, r), job.reject)
      .finally(() => {
        this.inFlight--;
        this.pump();
      });
  }

  private runOnHelper(job: QueuedRender, helper: DrawingHelper) {
    helper.busy = true;
    helper
      .render(job.req)
      .then(
        (r) => this.finish(job, r),
        () => {
          // Whatever went wrong in the helper, the main engine draws it instead.
          this.queue.push({ ...job, mainOnly: true });
        },
      )
      .finally(() => {
        helper.busy = false;
        this.pump();
      });
  }
}

let shared: EngineClient | null = null;
export function engine(): EngineClient {
  return (shared ??= new EngineClient());
}
