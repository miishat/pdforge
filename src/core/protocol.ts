// Message protocol between the UI thread and the engine worker.
import type { DocInfo, OpenResult } from "./types";

export type Request =
  | { op: "open"; bytes: Uint8Array }
  | { op: "unlock"; docId: number; password: string }
  | { op: "render"; docId: number; pageIndex: number; scale: number }
  | { op: "close"; docId: number };

export interface Responses {
  open: OpenResult;
  unlock: DocInfo;
  render: { bitmap: ImageBitmap; width: number; height: number };
  close: void;
}

export type Envelope = { id: number } & Request;

export type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; code?: string };
