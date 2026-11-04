/// <reference lib="webworker" />
// The message handler is installed before MuPDF loads: the WASM module uses top-level await,
// and messages that arrive while a module worker is still evaluating would otherwise be lost.
import type { Envelope, Reply } from "./protocol";
import type { RenderRequest } from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const ready = import("./engine").then((m) => ({ engine: new m.PdfEngine(), EngineError: m.EngineError }));

scope.onmessage = async (event: MessageEvent<Envelope>) => {
  const { id, op, args } = event.data;
  let loaded;
  try {
    loaded = await ready;
  } catch (err) {
    return reply({ id, ok: false, message: `The PDF engine failed to start (${String(err)}).` });
  }
  const { engine, EngineError } = loaded;
  try {
    if (op === "render") {
      const page = engine.render(args[0] as RenderRequest);
      const image = new ImageData(page.pixels as Uint8ClampedArray<ArrayBuffer>, page.width, page.height);
      const bitmap = await createImageBitmap(image);
      return reply({ id, ok: true, value: { bitmap, width: page.width, height: page.height } }, [bitmap]);
    }
    const fn = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
    if (typeof fn !== "function" || op.startsWith("_")) throw new Error(`Unknown engine operation "${op}".`);
    const value = await fn.apply(engine, args);
    const transfer = value instanceof Uint8Array ? [value.buffer] : [];
    reply({ id, ok: true, value }, transfer);
  } catch (err) {
    const code = err instanceof EngineError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    reply({ id, ok: false, message, code });
  }
};

function reply(r: Reply, transfer: Transferable[] = []) {
  scope.postMessage(r, transfer);
}
