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
}

/** Renders are queued in the UI thread so stale requests can be dropped before reaching the worker. */
const MAX_RENDERS_IN_FLIGHT = 2;

export class EngineClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: QueuedRender[] = [];
  private inFlight = 0;

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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args } as Envelope, transfer);
    });
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

  private pump() {
    while (this.inFlight < MAX_RENDERS_IN_FLIGHT && this.queue.length) {
      this.queue = this.queue.filter((q) => {
        if (q.signal?.aborted) q.reject(new CancelledError());
        return !q.signal?.aborted;
      });
      if (!this.queue.length) return;
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[best].priority) best = i;
      const job = this.queue.splice(best, 1)[0];
      this.inFlight++;
      this.call("render", job.req)
        .then((r) => {
          if (job.signal?.aborted) {
            r.bitmap.close();
            job.reject(new CancelledError());
          } else job.resolve(r);
        }, job.reject)
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }
}

let shared: EngineClient | null = null;
export function engine(): EngineClient {
  return (shared ??= new EngineClient());
}
