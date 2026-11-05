/// <reference lib="webworker" />
// A helper that reads page text in parallel with the main engine, for searching large documents.
// It opens its own copy of the file and answers { from, to } requests with the plain text of those pages.
import { plainPageText } from "./plaintext";

export type TextWorkerRequest = { kind: "open"; bytes: Uint8Array } | { kind: "read"; from: number; to: number };
export type TextWorkerReply = { kind: "opened"; pageCount: number } | { kind: "read"; from: number; texts: string[] } | { kind: "error"; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const mupdf = import("mupdf");
let doc: import("mupdf").Document | null = null;

scope.onmessage = async (event: MessageEvent<TextWorkerRequest>) => {
  const msg = event.data;
  try {
    const m = await mupdf;
    if (msg.kind === "open") {
      doc = m.Document.openDocument(msg.bytes, "application/pdf");
      return post({ kind: "opened", pageCount: doc.countPages() });
    }
    if (!doc) throw new Error("No document is open.");
    const texts: string[] = [];
    for (let p = msg.from; p < msg.to; p++) texts.push(plainPageText(doc, p));
    post({ kind: "read", from: msg.from, texts });
  } catch (err) {
    post({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

function post(r: TextWorkerReply) {
  scope.postMessage(r);
}
