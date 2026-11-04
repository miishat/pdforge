import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "./core/client";
import type { DocInfo } from "./core/types";
import { fromBrowserFile, isDesktop, launchFiles, onOpenFiles, pickPdfs, readPath, setWindowTitle, type PickedFile } from "./platform";
import { DocumentView } from "./ui/doc/DocumentView";
import { ErrorPanel } from "./ui/ErrorPanel";
import { PasswordPrompt } from "./ui/PasswordPrompt";
import { addRecent, loadRecent, removeRecent, samePath, saveRecent, updateRecent, type RecentFile } from "./ui/recent";
import { StartScreen } from "./ui/StartScreen";
import { TitleBar } from "./ui/TitleBar";
import { useTabs, type Tab } from "./ui/useTabs";

export function App() {
  const { tabs, activeId, setActiveId, open, unlock, close, cycle } = useTabs();
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
              />
            );
        }
      })}
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
