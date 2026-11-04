import { useCallback, useRef, useState } from "react";
import { engine, EngineClientError } from "../core/client";
import type { DocInfo } from "../core/types";
import type { PickedFile } from "../platform";
import { samePath } from "./recent";

export type TabState =
  | { kind: "loading" }
  | { kind: "locked"; docId: number; wrongPassword: boolean }
  | { kind: "ready"; info: DocInfo }
  | { kind: "error"; message: string };

export interface Tab {
  id: number;
  name: string;
  path: string | null;
  fileSize: number;
  initialPage: number;
  state: TabState;
  dirty: boolean;
  /** Restored from crash recovery: counts as changed until saved. */
  recovered?: boolean;
}

let nextTabId = 1;

export function useTabs() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const patch = (id: number, state: TabState) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, state } : t)));

  const open = useCallback(async (file: PickedFile, initialPage = 0, opts: { recovered?: boolean } = {}) => {
    // A file that is already open just gets focus.
    const existing = file.path && !opts.recovered ? tabsRef.current.find((t) => t.path && samePath(t.path, file.path!)) : undefined;
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const id = nextTabId++;
    const tab: Tab = { id, name: file.name, path: file.path, fileSize: file.bytes.byteLength, initialPage, state: { kind: "loading" }, dirty: false, recovered: opts.recovered };
    setTabs((ts) => [...ts, tab]);
    setActiveId(id);
    try {
      const result = await engine().call("open", file.bytes);
      if (!tabsRef.current.some((t) => t.id === id)) {
        // Closed while loading.
        const docId = result.status === "ok" ? result.info.docId : result.docId;
        void engine().call("close", docId);
        return;
      }
      if (result.status === "needs-password") patch(id, { kind: "locked", docId: result.docId, wrongPassword: false });
      else {
        if (opts.recovered) await engine().call("markDirty", result.info.docId);
        patch(id, { kind: "ready", info: result.info });
      }
    } catch (err) {
      patch(id, { kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const unlock = useCallback(async (id: number, password: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab?.state.kind !== "locked") return;
    const { docId } = tab.state;
    try {
      const info = await engine().call("unlock", docId, password);
      patch(id, { kind: "ready", info });
    } catch (err) {
      if (err instanceof EngineClientError && err.code === "bad-password") patch(id, { kind: "locked", docId, wrongPassword: true });
      else patch(id, { kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const close = useCallback((id: number) => {
    const ts = tabsRef.current;
    const i = ts.findIndex((t) => t.id === id);
    if (i < 0) return;
    const s = ts[i].state;
    if (s.kind === "ready") void engine().call("close", s.info.docId);
    if (s.kind === "locked") void engine().call("close", s.docId);
    const rest = ts.filter((t) => t.id !== id);
    setTabs(rest);
    setActiveId((cur) => (cur === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : cur));
  }, []);

  const cycle = useCallback((dir: 1 | -1) => {
    const ts = tabsRef.current;
    if (ts.length < 2) return;
    setActiveId((cur) => {
      const i = ts.findIndex((t) => t.id === cur);
      return ts[(i + dir + ts.length) % ts.length].id;
    });
  }, []);

  const setDirty = useCallback((id: number, dirty: boolean) => {
    setTabs((ts) => (ts.some((t) => t.id === id && t.dirty !== dirty) ? ts.map((t) => (t.id === id ? { ...t, dirty } : t)) : ts));
  }, []);

  const relocate = useCallback((id: number, path: string | null, name: string) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, path: path ?? t.path, name, recovered: false } : t)));
  }, []);

  return { tabs, activeId, setActiveId, open, unlock, close, cycle, setDirty, relocate };
}
