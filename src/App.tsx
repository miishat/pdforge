import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { engine } from "./core/client";
import type { DocInfo } from "./core/types";
import {
  fromBrowserFile, isDesktop, isMac, launchFiles, onOpenFiles, onWindowCloseRequested, pickFiles, pickPdfs, readPath, recoveryClear, recoveryList,
  recoveryRead, savedTextStore, addRecentDocument, setWindowTitle, appVersion, type AvailableUpdate, type PickedFile, type RecoveryMeta,
} from "./platform";
import { UnsavedDialog } from "./ui/doc/Dialogs";
import { DocumentView, type DocCommands, type ViewHandle } from "./ui/doc/DocumentView";
import { EDIT_ROUTED, menuLayout } from "./ui/appMenu";
import { setAppMenu } from "./platform/menu";
import { COMMAND_BY_ID, shortcutLabel, comboOf, effectiveKeymap, loadOverrides, loadVim, reverseKeymap, saveOverrides, saveVim, type Keymap } from "./ui/commands";
import { CommandPalette } from "./ui/CommandPalette";
import { ShortcutsDialog } from "./ui/ShortcutsDialog";
import { CompareView, type CompareSide } from "./ui/compare/CompareView";
import { BatchDialog } from "./ui/batch/BatchDialog";
import { ErrorPanel } from "./ui/ErrorPanel";
import { PasswordPrompt } from "./ui/PasswordPrompt";
import { addRecent, loadRecent, removeRecent, samePath, saveRecent, updateRecent, type RecentFile } from "./ui/recent";
import { StartScreen } from "./ui/StartScreen";
import { TitleBar } from "./ui/TitleBar";
import { UpdateBar } from "./ui/UpdateBar";
import { autoUpdatesOn, setAutoUpdates, useUpdates } from "./ui/updates";
import { useTabs, type Tab } from "./ui/useTabs";
import { IMPORTABLE } from "./core/convert";
import { defaultPaper } from "./ui/paper";
import { clearSavedText } from "./ui/doc/savedText";
import { useDefaultAppOffer } from "./ui/defaultApp";

function formatMB(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Distinguishes this run's recovery files from those left by a previous (crashed) run. */
const SESSION = Date.now().toString(36);

/** Whether the user is typing in a text field (where single-key shortcuts and the document's Undo don't apply). */
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement)?.tagName ?? "") || !!(document.activeElement as HTMLElement)?.isContentEditable;

export function App() {
  const { tabs, activeId, setActiveId, open, unlock, close: closeNow, cycle, setDirty, relocate, setInfo } = useTabs();
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

  const [notice, setNotice] = useState<string | null>(null);
  const [infoNote, setInfoNote] = useState<string | null>(null);
  const updates = useUpdates();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void appVersion().then(setVersion, () => {});
  }, []);
  const defaultApp = useDefaultAppOffer(updates.state.kind !== "idle");
  const makeDefault = useCallback(async () => {
    setNotice(null);
    const error = await defaultApp.makeDefault();
    if (error) setNotice(error);
    else setInfoNote(`In Settings, choose PDForge for .pdf files. You can do this later from the command palette (${shortcutLabel("window.palette")}): “Make PDForge the default PDF app…”.`);
  }, [defaultApp]);
  const installUpdate = useCallback(
    async (update: AvailableUpdate) => {
      // The installer closes PDForge, so settle unsaved changes first.
      const ids = tabsRef.current.map((t) => t.id);
      if (!(await confirmClose(ids))) return;
      for (const id of ids) void recoveryClear(`${SESSION}-${id}`);
      await updates.install(update);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updates.install],
  );

  /** Lays out Office documents, web pages, text and images as a new, unsaved PDF tab. */
  const convertAndOpen = useCallback(
    async (files: PickedFile[], name: string, fitImages: boolean) => {
      try {
        const bytes = await engine().call("convertToPdf", files.map((f) => ({ name: f.name, bytes: f.bytes })), { pageSize: defaultPaper().size, fitImages });
        await open({ name, path: null, bytes }, 0, { recovered: true });
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [open],
  );

  const openFiles = useCallback(
    (files: PickedFile[]) => {
      for (const f of files) {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        if (ext !== "pdf" && IMPORTABLE[ext]) void convertAndOpen([f], f.name.replace(/\.[^.]+$/, "") + ".pdf", false);
        else void open(f, rememberedPage(f.path));
      }
    },
    [open, convertAndOpen],
  );
  const createPdf = useCallback(async () => {
    let files: PickedFile[];
    try {
      files = await pickFiles({ name: "Documents and images", extensions: Object.keys(IMPORTABLE) });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!files.length) return;
    const name = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, "") + ".pdf" : "Combined.pdf";
    await convertAndOpen(files, name, true);
  }, [convertAndOpen]);
  const openPaths = useCallback(
    async (paths: string[]) => {
      for (const p of paths) {
        try {
          openFiles([await readPath(p)]);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/doesn't exist/.test(message)) setMissing((m) => new Set(m).add(p));
          else setNotice(message);
          console.warn(err);
        }
      }
    },
    [openFiles],
  );
  const openDialog = useCallback(
    () => pickPdfs().then(openFiles, (err) => setNotice(err instanceof Error ? err.message : String(err))),
    [openFiles],
  );

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
      void addRecentDocument(path);
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

  // ---- Commands: palette, shortcuts (rebindable), vim keys ----
  const [overrides, setOverrides] = useState<Keymap>(loadOverrides);
  const [vim, setVim] = useState(loadVim);
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [batch, setBatch] = useState(false);
  const [compare, setCompare] = useState<{ a: CompareSide } | null>(null);
  const keymap = useMemo(() => effectiveKeymap(overrides), [overrides]);
  const docCommands = useRef<DocCommands | null>(null);
  const registerCommands = useCallback((c: DocCommands | null, previous?: DocCommands) => {
    if (c) docCommands.current = c;
    else if (docCommands.current === previous) docCommands.current = null;
  }, []);

  // ---- Split view ----
  const [split, setSplit] = useState<{ left: number; right: number } | null>(null);
  const [syncScroll, setSyncScroll] = useState(true);
  const splitPending = useRef<number | null>(null);
  const readyIds = tabs.filter((t) => t.state.kind === "ready").map((t) => t.id);
  const splitOn = !!split && readyIds.includes(split.left) && readyIds.includes(split.right) && (activeId === split.left || activeId === split.right);
  const toggleSplit = useCallback(() => {
    if (splitOn) return setSplit(null);
    if (activeId == null) return;
    const other = [...tabsRef.current].reverse().find((t) => t.id !== activeId && t.state.kind === "ready");
    if (other) setSplit({ left: activeId, right: other.id });
    else {
      // Only one document: pick a second one to show beside it.
      splitPending.current = activeId;
      void openDialog();
    }
  }, [splitOn, activeId, openDialog]);
  useEffect(() => {
    const first = splitPending.current;
    if (first == null || activeId == null || activeId === first) return;
    if (tabs.find((t) => t.id === activeId)?.state.kind === "ready") {
      splitPending.current = null;
      setSplit({ left: first, right: activeId });
    }
  }, [activeId, tabs]);
  const views = useRef(new Map<number, ViewHandle>());
  // The view we last scrolled to match the other one, and where that left it: a scroll event from it
  // at that same position is our own echo, anything else is the person scrolling.
  const echo = useRef<{ id: number; top: number } | null>(null);
  const onViewScroll = useCallback(
    (id: number) => {
      if (!splitOn || !syncScroll || !split) return;
      const from = views.current.get(id);
      if (!from) return;
      if (echo.current?.id === id && Math.abs(from.scrollTop() - echo.current.top) < 2) return;
      const other = id === split.left ? split.right : id === split.right ? split.left : null;
      const to = other != null ? views.current.get(other) : undefined;
      if (!to || other == null) return;
      to.scrollTo(from.here());
      echo.current = { id: other, top: to.scrollTop() };
    },
    [splitOn, syncScroll, split],
  );

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const appCommands: Record<string, (() => void) | undefined> = {
    "file.open": () => void openDialog(),
    "file.create": () => void createPdf(),
    "file.close": activeId != null ? () => void close(activeId) : undefined,
    "file.batch": () => setBatch(true),
    "file.compare": activeTab?.state.kind === "ready" ? () => setCompare({ a: { docId: (activeTab.state as { info: DocInfo }).info.docId, name: activeTab.name } }) : undefined,
    "window.palette": () => setPalette(true),
    "window.nextTab": tabs.length > 1 ? () => cycle(1) : undefined,
    "window.prevTab": tabs.length > 1 ? () => cycle(-1) : undefined,
    "window.split": activeTab?.state.kind === "ready" ? toggleSplit : undefined,
    "window.syncScroll": splitOn ? () => setSyncScroll((v) => !v) : undefined,
    "window.shortcuts": () => setShortcuts(true),
    "window.defaultApp": isDesktop && !isMac ? () => void makeDefault() : undefined,
    "window.clearSearchData": async () => {
      setNotice(null);
      try {
        const size = (await savedTextStore.list()).reduce((n, e) => n + e.size, 0);
        await clearSavedText();
        setInfoNote(size ? `Saved search data cleared (${formatMB(size)}). Large PDFs read their text again on their next search.` : "There was no saved search data.");
      } catch (err) {
        setNotice(`Couldn't clear the saved search data: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    "window.checkUpdates": isDesktop ? () => void updates.check(true) : undefined,
    "window.autoUpdates": isDesktop
      ? () => {
          const on = !autoUpdatesOn();
          setAutoUpdates(on);
          setNotice(null);
          setInfoNote(on ? "PDForge will check for updates on its own." : `Automatic update checks are off. Use “Check for updates…” in the command palette (${shortcutLabel("window.palette")}) any time.`);
        }
      : undefined,
  };
  const appCommandsRef = useRef(appCommands);
  appCommandsRef.current = appCommands;
  const available = useCallback((id: string) => !!appCommandsRef.current[id] || !!docCommands.current?.has(id), []);
  const runCommand = useCallback((id: string) => {
    const app = appCommandsRef.current[id];
    if (app) app();
    else docCommands.current?.run(id);
  }, []);
  /** The last command run from the keyboard, so a Mac menu item with the same shortcut doesn't run it twice. */
  const lastKeyCommand = useRef({ id: "", at: 0 });

  // The Mac menu bar: the same commands, run the same way as from the keyboard or the palette.
  const runMenuCommand = useCallback(
    (id: string) => {
      if (lastKeyCommand.current.id === id && performance.now() - lastKeyCommand.current.at < 300) return;
      // Undo and Redo act on the text being typed, if any.
      if (EDIT_ROUTED.has(id) && typing()) return void document.execCommand(id === "edit.undo" ? "undo" : "redo");
      if (document.querySelector("dialog[open]") || !available(id)) return;
      runCommand(id);
    },
    [available, runCommand],
  );
  useEffect(() => {
    if (!isDesktop || !isMac) return;
    setAppMenu(menuLayout(keymap), runMenuCommand, version).catch((err) => console.warn("Menu bar:", err));
  }, [keymap, runMenuCommand, version]);

  useEffect(() => {
    const reverse = reverseKeymap(keymap);
    let lastG = 0;
    const VIM: Record<string, string> = { j: "vim.down", k: "vim.up", d: "vim.halfDown", u: "vim.halfUp", h: "vim.prevPage", l: "vim.nextPage", G: "vim.last", "/": "vim.find", n: "vim.next", N: "vim.prev" };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
      const doc = docCommands.current;
      if (vim && doc && !typing() && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "g") {
          e.preventDefault();
          if (Date.now() - lastG < 700) {
            lastG = 0;
            doc.run("vim.first");
          } else lastG = Date.now();
          return;
        }
        const v = VIM[e.key];
        if (v) {
          e.preventDefault();
          doc.run(v);
          return;
        }
      }
      const combo = comboOf(e);
      const id = combo && reverse.get(combo);
      if (!id) return;
      if (typing() && !COMMAND_BY_ID.get(id)?.inInput) return;
      if (!available(id)) return;
      e.preventDefault();
      lastKeyCommand.current = { id, at: performance.now() };
      runCommand(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keymap, vim, available, runCommand]);

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
          void openPaths(p.paths);
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
          try {
            openFiles(await Promise.all([...e.dataTransfer.files].map(fromBrowserFile)));
          } catch (err) {
            setNotice(err instanceof Error ? err.message : String(err));
          }
        },
      };

  function rememberedPage(path: string | null): number {
    if (!path) return 0;
    return recent.find((r) => samePath(r.path, path))?.page ?? 0;
  }

  return (
    <div className="app" {...browserDrop}>
      <TitleBar tabs={tabs} activeId={activeId} onActivate={setActiveId} onClose={close} onNew={openDialog} />
      <UpdateBar state={updates.state} onInstall={(u) => void installUpdate(u)} onDismiss={updates.dismiss} onRetry={() => void updates.check(true)} />
      {defaultApp.offer && (
        <div className="infobar app-notice" role="status">
          <span>PDForge isn't your default app for PDF files.</span>
          <button className="button button--small button--primary" onClick={() => void makeDefault()}>
            Make default
          </button>
          <button className="link-button" onClick={defaultApp.dismiss}>Not now</button>
        </div>
      )}
      {infoNote && (
        <div className="infobar infobar--good app-notice" role="status">
          {infoNote}
          <button className="link-button" onClick={() => setInfoNote(null)}>Dismiss</button>
        </div>
      )}
      {notice && (
        <div className="infobar infobar--bad app-notice" role="alert">
          {notice}
          <button className="link-button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {!active && (
        <StartScreen
          onCreate={() => void createPdf()}
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
          version={version}
          onCheckUpdates={isDesktop ? () => void updates.check(true) : undefined}
        />
      )}
      <div className={`workspace ${splitOn ? "workspace--split" : ""}`}>
      {splitOn && (
        <div className="split-bar" role="toolbar" aria-label="Split view">
          <label className="check"><input type="checkbox" checked={syncScroll} onChange={(e) => setSyncScroll(e.target.checked)} /> Scroll together</label>
          <button className="link-button" onClick={() => setSplit(null)}>Close split view</button>
        </div>
      )}
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        const inSplit = splitOn && split && (t.id === split.left || t.id === split.right);
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
                visible={!!inSplit}
                splitSide={inSplit ? (t.id === split!.left ? "left" : "right") : undefined}
                onFocusView={inSplit && !isActive ? () => setActiveId(t.id) : undefined}
                registerCommands={registerCommands}
                onCommand={runCommand}
                registerView={(h) => {
                  if (h) views.current.set(t.id, h);
                  else views.current.delete(t.id);
                }}
                onViewScroll={() => onViewScroll(t.id)}
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
                onInfo={(info) => setInfo(t.id, info)}
                onOpenNew={(name, bytes) => void open({ name, path: null, bytes }, 0, { recovered: true })}
              />
            );
        }
      })}
      </div>
      {palette && <CommandPalette available={available} keymap={keymap} onRun={runCommand} onClose={() => setPalette(false)} />}
      {shortcuts && (
        <ShortcutsDialog
          overrides={overrides}
          vim={vim}
          onChange={(o) => {
            setOverrides(o);
            saveOverrides(o);
          }}
          onVim={(on) => {
            setVim(on);
            saveVim(on);
          }}
          onClose={() => setShortcuts(false)}
        />
      )}
      {compare && (
        <CompareView
          a={compare.a}
          others={tabs.filter((t) => t.state.kind === "ready" && t.id !== activeId).map((t) => ({ docId: (t.state as { info: DocInfo }).info.docId, name: t.name }))}
          onClose={() => setCompare(null)}
        />
      )}
      {batch && <BatchDialog onClose={() => setBatch(false)} />}
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
