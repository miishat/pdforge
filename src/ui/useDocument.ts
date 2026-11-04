import { useCallback, useState } from "react";
import { engine, EngineClientError } from "../core/client";
import type { DocInfo } from "../core/types";
import type { PickedFile } from "../platform";

export type DocState =
  | { kind: "empty" }
  | { kind: "loading"; name: string }
  | { kind: "locked"; name: string; docId: number; wrongPassword: boolean }
  | { kind: "ready"; name: string; path: string | null; info: DocInfo }
  | { kind: "error"; name: string; message: string };

export function useDocument() {
  const [state, setState] = useState<DocState>({ kind: "empty" });

  const open = useCallback(async (file: PickedFile) => {
    setState((prev) => {
      if (prev.kind === "ready") void engine().call({ op: "close", docId: prev.info.docId });
      return { kind: "loading", name: file.name };
    });
    try {
      const bytes = file.bytes;
      const result = await engine().call({ op: "open", bytes }, [bytes.buffer]);
      if (result.status === "needs-password") {
        setState({ kind: "locked", name: file.name, docId: result.docId, wrongPassword: false });
      } else {
        setState({ kind: "ready", name: file.name, path: file.path, info: result.info });
      }
    } catch (err) {
      setState({ kind: "error", name: file.name, message: messageOf(err) });
    }
  }, []);

  const unlock = useCallback(async (password: string) => {
    if (state.kind !== "locked") return;
    try {
      const info = await engine().call({ op: "unlock", docId: state.docId, password });
      setState({ kind: "ready", name: state.name, path: null, info });
    } catch (err) {
      if (err instanceof EngineClientError && err.code === "bad-password") {
        setState({ ...state, wrongPassword: true });
      } else {
        setState({ kind: "error", name: state.name, message: messageOf(err) });
      }
    }
  }, [state]);

  const close = useCallback(() => {
    if (state.kind === "ready") void engine().call({ op: "close", docId: state.info.docId });
    if (state.kind === "locked") void engine().call({ op: "close", docId: state.docId });
    setState({ kind: "empty" });
  }, [state]);

  return { state, open, unlock, close };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
