// Promise-based client for the engine worker. One worker per app window.
import type { Envelope, Reply, Request, Responses } from "./protocol";

export class EngineClientError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class EngineClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;

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

  call<R extends Request>(req: R, transfer: Transferable[] = []): Promise<Responses[R["op"]]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, ...req } as Envelope, transfer);
    });
  }
}

let shared: EngineClient | null = null;
export function engine(): EngineClient {
  return (shared ??= new EngineClient());
}
