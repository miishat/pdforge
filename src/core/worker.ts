/// <reference lib="webworker" />
// The message handler is installed before MuPDF loads: the WASM module uses top-level await,
// and messages that arrive while a module worker is still evaluating would otherwise be lost.
import type { Envelope, Reply } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const ready = import("./engine").then((m) => ({ engine: new m.PdfEngine(), EngineError: m.EngineError }));

scope.onmessage = async (event: MessageEvent<Envelope>) => {
  const msg = event.data;
  const { engine, EngineError } = await ready.catch((err) => {
    reply({ id: msg.id, ok: false, message: `The PDF engine failed to start (${String(err)}).` });
    throw err;
  });
  try {
    switch (msg.op) {
      case "open":
        return reply({ id: msg.id, ok: true, value: engine.open(msg.bytes) });
      case "unlock":
        return reply({ id: msg.id, ok: true, value: engine.unlock(msg.docId, msg.password) });
      case "render": {
        const page = engine.render(msg.docId, msg.pageIndex, msg.scale);
        const image = new ImageData(page.pixels as Uint8ClampedArray<ArrayBuffer>, page.width, page.height);
        const bitmap = await createImageBitmap(image);
        return reply({ id: msg.id, ok: true, value: { bitmap, width: page.width, height: page.height } }, [bitmap]);
      }
      case "close":
        engine.close(msg.docId);
        return reply({ id: msg.id, ok: true, value: undefined });
    }
  } catch (err) {
    const code = err instanceof EngineError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    reply({ id: msg.id, ok: false, message, code });
  }
};

function reply(r: Reply, transfer: Transferable[] = []) {
  scope.postMessage(r, transfer);
}
