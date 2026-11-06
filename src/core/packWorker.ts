/// <reference lib="webworker" />
// Compresses saved page text away from the engine and the UI, so neither stalls on it (a few seconds for 17,000 pages).
import { packPlainText } from "./plainStore";

export type PackRequest = { kind: "pack"; texts: string[] };
export type PackReply = { kind: "packed"; data: Uint8Array } | { kind: "error"; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e: MessageEvent<PackRequest>) => {
  try {
    const data = await packPlainText(e.data.texts);
    scope.postMessage({ kind: "packed", data } satisfies PackReply, [data.buffer]);
  } catch (err) {
    scope.postMessage({ kind: "error", message: String(err) } satisfies PackReply);
  }
};
