import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "./core/client";
import type { DocInfo } from "./core/types";
import {
  fromBrowserFile, isDesktop, launchFiles, onOpenFiles, onWindowCloseRequested, pickPdfs, readPath, recoveryClear, recoveryList,
  recoveryRead, setWindowTitle, type PickedFile, type RecoveryMeta,
} from "./platform";
import { UnsavedDialog } from "./ui/doc/Dialogs";
import { DocumentView } from "./ui/doc/DocumentView";
import { ErrorPanel } from "./ui/ErrorPanel";
import { PasswordPrompt } from "./ui/PasswordPrompt";
import { addRecent, loadRecent, removeRecent, samePath, saveRecent, updateRecent, type RecentFile } from "./ui/recent";
import { StartScreen } from "./ui/StartScreen";
import { TitleBar } from "./ui/TitleBar";
import { useTabs, type Tab } from "./ui/useTabs";

/** Distinguishes this run's recovery files from those left by a previous (crashed) run. */
const SESSION = Date.now().toString(36);

export function App() {
  const { tabs, activeId, setActiveId, open, unlock, close: closeNow, cycle, setDirty, relocate } = useTabs();
  const savers = useRef(new Map<number, () => Promise<boolean>>());
  const [prompt, setPrompt] = useState<{ ids: number[]; resolve: (ok: boolean) => void } | null>(null);
  const [recoveries, setRecoveries] = useState<{ key: string; meta: RecoveryMeta }[]>([]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /** Asks about unsaved changes in these tabs. Resolves true when it's fine to close them. */
  const confirmClose = useCallback((ids: number[]): Promise<boolean> => {
    const dirty = ids.filter((id) => tabsRef.current.find((t) => t.id === id)?.dirty);
    if (!dirty.length) return Promise.resolve(true);
    return new Promise((resolve) => setPrompt({ ids: dirty, resolve }));
  }, []);

  const close = useCallback(
    async (id: number) => {
      if (await confirmClose([id])) {
        void recoveryClear(`${SESSION}-${id}`);
        closeNow(id);
      }
    },
    [confirmClose, closeNow],
  );

  // Closing the window with unsaved work asks first.
  useEffect(() => {
    let off: (() => void) | undefined;
    onWindowCloseRequested(async () => {
      const ok = await confirmClose(tabsRef.current.map((t) => t.id));
      if (ok) for (const t of tabsRef.current) await recoveryClear(`${SESSION}-${t.id}`);
      return ok;
    }).then((u) => (off = u));
    return () => off?.();
  }, [confirmClose]);

  // Documents left unsaved by a previous run that didn't close properly.
  useEffect(() => {
    recoveryList().then((list) => setRecoveries(list.filter((r) => !r.key.startsWith(`${SESSION}-`))));
  }, []);
  const [dragging, setDragging] = useState(false);
  const [recent, setRecent] = useState<RecentFile[]>(() => (isDesktop ? loadRecent() : []));
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const active = tabs.find((t) => t.id === activeId) ?? null;

  useEffect(() => saveRecent(recent), [recent]);

  const openFiles = useCallback((files: PickedFile[]) => files.forEach((f) => open(f, rememberedPage(f.path))), [open]);
  const openPaths = useCallback(
    async (paths: string[]) => {
      for (const p of paths) {
        try {
          await open(await readPath(p), rememberedPage(p));
        } catch (err) {
          setMissing((m) => new Set(m).add(p));
          console.warn(err);
        }
      }
    },
    [open],
  );
  const openDialog = useCallback(() => pickPdfs().then(openFiles), [openFiles]);

  // Files from Windows: at launch, and later from a second launch (single-instance).
  useEffect(() => {
    launchFiles().then(openPaths).catch(() => {});
    let off: (() => void) | undefined;
    onOpenFiles(openPaths).then((u) => (off = u));
    return () => off?.();
  }, [openPaths]);

  useEffect(() => {
    void setWindowTitle(active ? `${active.name} – PDForge` : "PDForge");
  }, [active]);

  // Track files in the recent list once they open, with a small first-page thumbnail.
  const recorded = useRef(new Set<number>());
  useEffect(() => {
    for (const t of tabs) {
      if (t.state.kind !== "ready" || !t.path || recorded.current.has(t.id)) continue;
      recorded.current.add(t.id);
      const path = t.path;
      const info = t.state.info;
      setRecent((list) => addRecent(list, { path, name: t.name, openedAt: Date.now(), pageCount: info.pageCount }));
      setMissing((m) => {
        const n = new Set(m);
        n.delete(path);
        return n;
      });
      void makeThumb(info).then((thumb) => thumb && setRecent((list) => updateRecent(list, path, { thumb })));
    }
  }, [tabs]);

  const onPageChange = useCallback((tab: Tab, page: number) => {
    if (tab.path) setRecent((list) => updateRecent(list, tab.path!, { page }));
  }, []);

  // App-wide shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        void openDialog();
      } else if (k === "w" || k === "f4") {
        if (activeId != null) {
          e.preventDefault();
          close(activeId);
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog, close, cycle, activeId]);

  // Drag and drop: Tauri hands us file paths; the browser hands us File objects.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          const pdfs = p.paths.filter((path) => path.toLowerCase().endsWith(".pdf"));
          void openPaths(pdfs.length ? pdfs : p.paths.slice(0, 1));
        }
      });
    });
    return () => unlisten?.();
  }, [openPaths]);

  const browserDrop = isDesktop
    ? {}
    : {
        onDragOver: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        },
        onDrop: async (e: React.DragEvent) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          openFiles(await Promise.all([...e.dataTransfer.files].map(fromBrowserFile)));
        },
      };

  function rememberedPage(path: string | null): number {
    if (!path) return 0;
    return recent.find((r) => samePath(r.path, path))?.page ?? 0;
  }

  return (
    <div className="app" {...browserDrop}>
      <TitleBar tabs={tabs} activeId={activeId} onActivate={setActiveId} onClose={close} onNew={openDialog} />
      {!active && (
        <StartScreen
          recoveries={recoveries}
          onRecover={async (r) => {
            try {
              const bytes = await recoveryRead(r.key);
              await open({ name: r.meta.name, path: r.meta.path, bytes }, 0, { recovered: true });
              await recoveryClear(r.key);
            } catch {
              /* unreadable recovery file */
            }
            setRecoveries((l) => l.filter((x) => x.key !== r.key));
          }}
          onDiscardRecovery={(r) => {
            void recoveryClear(r.key);
            setRecoveries((l) => l.filter((x) => x.key !== r.key));
          }}
          recent={recent}
          missing={missing}
          onOpen={openDialog}
          onOpenRecent={(r) => openPaths([r.path])}
          onRemoveRecent={(r) => setRecent((l) => removeRecent(l, r.path))}
        />
      )}
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        switch (t.state.kind) {
          case "loading":
            return (
              isActive && (
                <main key={t.id} className="center-panel" aria-busy="true">
                  <div className="loading-bar" />
                </main>
              )
            );
          case "locked":
            return (
              isActive && (
                <PasswordPrompt
                  key={t.id}
                  name={t.name}
                  wrongPassword={t.state.wrongPassword}
                  onSubmit={(pw) => unlock(t.id, pw)}
                  onCancel={() => close(t.id)}
                />
              )
            );
          case "error":
            return isActive && <ErrorPanel key={t.id} name={t.name} message={t.state.message} onOpen={openDialog} />;
          case "ready":
            return (
              <DocumentView
                key={t.id}
                info={t.state.info}
                name={t.name}
                path={t.path}
                fileSize={t.fileSize}
                active={isActive}
                initialPage={t.initialPage}
                onPageChange={(p) => onPageChange(t, p)}
                onClose={() => close(t.id)}
                onEditState={(st) => setDirty(t.id, st.dirty || !!t.recovered)}
                onSaved={(path, name) => {
                  relocate(t.id, path, name);
                  setDirty(t.id, false);
                  if (path) setRecent((list) => addRecent(list, { path, name, openedAt: Date.now(), pageCount: (t.state as { info: DocInfo }).info.pageCount }));
                }}
                registerSave={(fn) => {
                  if (fn) savers.current.set(t.id, fn);
                  else savers.current.delete(t.id);
                }}
                recoveryKey={`${SESSION}-${t.id}`}
              />
            );
        }
      })}
      {prompt && (
        <UnsavedDialog
          names={prompt.ids.map((id) => tabsRef.current.find((t) => t.id === id)?.name ?? "Document")}
          onCancel={() => {
            prompt.resolve(false);
            setPrompt(null);
          }}
          onDiscard={() => {
            prompt.resolve(true);
            setPrompt(null);
          }}
          onSave={async () => {
            const p = prompt;
            setPrompt(null);
            for (const id of p.ids) {
              setActiveId(id);
              const save = savers.current.get(id);
              if (!save || !(await save())) return p.resolve(false);
            }
            p.resolve(true);
          }}
        />
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop to open</span>
        </div>
      )}
    </div>
  );
}

async function makeThumb(info: DocInfo): Promise<string | null> {
  try {
    const w = 88;
    const { bitmap } = await engine().render({ docId: info.docId, pageIndex: 0, scale: w / info.pages[0].width, rotation: 0 }, 50);
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return c.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}
