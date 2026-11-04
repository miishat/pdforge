import { useCallback, useEffect, useState } from "react";
import { fromBrowserFile, isDesktop, launchFile, pickPdf, readPath, setWindowTitle, type PickedFile } from "./platform";
import { ErrorPanel } from "./ui/ErrorPanel";
import { PasswordPrompt } from "./ui/PasswordPrompt";
import { StartScreen } from "./ui/StartScreen";
import { TitleBar } from "./ui/TitleBar";
import { useDocument } from "./ui/useDocument";
import { Viewer } from "./ui/Viewer";

export function App() {
  const { state, open, unlock, close } = useDocument();
  const [dragging, setDragging] = useState(false);

  const openPicked = useCallback((file: PickedFile | null) => file && open(file), [open]);
  const openDialog = useCallback(() => pickPdf().then(openPicked), [openPicked]);

  // Open a file passed by Windows ("Open with PDForge" / double-click).
  useEffect(() => {
    launchFile().then(openPicked).catch(() => {});
  }, [openPicked]);

  useEffect(() => {
    const name = state.kind === "empty" ? null : state.name;
    void setWindowTitle(name ? `${name} – PDForge` : "PDForge");
  }, [state]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openDialog();
      } else if (e.key.toLowerCase() === "w" && state.kind !== "empty") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog, close, state.kind]);

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
          const pdf = p.paths.find((path) => path.toLowerCase().endsWith(".pdf")) ?? p.paths[0];
          if (pdf) void readPath(pdf).then(openPicked);
        }
      });
    });
    return () => unlisten?.();
  }, [openPicked]);

  const browserDrop = isDesktop
    ? {}
    : {
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: (e: React.DragEvent) => {
          if (e.currentTarget === e.target) setDragging(false);
        },
        onDrop: async (e: React.DragEvent) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) openPicked(await fromBrowserFile(file));
        },
      };

  return (
    <div className="app" {...browserDrop}>
      <TitleBar tabTitle={state.kind === "empty" ? null : state.name} onCloseTab={close} />
      {state.kind === "empty" && <StartScreen onOpen={openDialog} />}
      {state.kind === "loading" && <main className="center-panel" aria-busy="true"><div className="loading-bar" /></main>}
      {state.kind === "locked" && (
        <PasswordPrompt key={state.docId} name={state.name} wrongPassword={state.wrongPassword} onSubmit={unlock} onCancel={close} />
      )}
      {state.kind === "error" && <ErrorPanel name={state.name} message={state.message} onOpen={openDialog} />}
      {state.kind === "ready" && <Viewer key={state.info.docId} info={state.info} />}
      {dragging && <div className="drop-overlay" aria-hidden="true"><span>Drop to open</span></div>}
    </div>
  );
}
