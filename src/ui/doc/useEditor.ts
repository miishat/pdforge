import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { EditResult, EditState } from "../../core/types";
import type { DocData } from "./docData";

const CLEAN: EditState = { canUndo: false, canRedo: false, dirty: false, undoLabel: null, redoLabel: null };

/**
 * Runs engine edits for one document: refreshes the affected pages' caches and rendering, and keeps
 * undo/redo and unsaved-changes state current.
 */
export function useEditor(data: DocData, onState: (s: EditState) => void, onError: (message: string) => void) {
  const [state, setState] = useState<EditState>(CLEAN);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  const refresh = useCallback(async () => {
    const s = await engine().call("editState", data.docId).catch(() => CLEAN);
    setState(s);
    onStateRef.current(s);
    return s;
  }, [data.docId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs an edit; returns its result, or null if it failed (the error is reported). */
  const run = useCallback(
    async <T extends EditResult>(op: () => Promise<T>, opts: { text?: boolean } = {}): Promise<T | null> => {
      try {
        const result = await op();
        data.invalidate(result.pages, opts);
        await refresh();
        return result;
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [data, refresh, onError],
  );

  const undo = useCallback(() => run(() => engine().call("undo", data.docId), { text: true }), [run, data.docId]);
  const redo = useCallback(() => run(() => engine().call("redo", data.docId), { text: true }), [run, data.docId]);

  return { state, run, undo, redo, refresh };
}
