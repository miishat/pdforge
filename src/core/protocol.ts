// Message protocol between the UI thread and the engine worker.
// Every public PdfEngine method is callable by name; `render` returns an ImageBitmap instead of raw pixels.
import type { PdfEngine } from "./engine";

type EngineApi = {
  [K in keyof PdfEngine as PdfEngine[K] extends (...args: never[]) => unknown ? K : never]: PdfEngine[K];
};

export type Op = keyof EngineApi;
export type Args<K extends Op> = Parameters<EngineApi[K]>;
export type Result<K extends Op> = K extends "render"
  ? { bitmap: ImageBitmap; width: number; height: number }
  : ReturnType<EngineApi[K]>;

export type Envelope = { id: number; op: Op; args: unknown[] };

export type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; code?: string };
