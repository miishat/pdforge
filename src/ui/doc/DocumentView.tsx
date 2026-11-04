import { Pause20Regular, Play20Regular, Stop20Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { AttachmentInfo, DocInfo, LayerInfo, LinkInfo, OutlineNode, Rect, ViewRotation } from "../../core/types";
import { copyPng, copyText, openExternal, saveBytes } from "../../platform";
import { Menu, type MenuEntry } from "../components/Menu";
import { rotate, rotatedSize, toView } from "../geometry";
import { extents, GAP, PAD, type LayoutMode } from "../layout";
import { load, save } from "../settings";
import { AUTO_MAX, clampZoom, PT_TO_CSS, stepZoom, type ZoomMode } from "../zoom";
import { Canvas, type CanvasHandle, type Dest, type ReadingMode, type Tool } from "./Canvas";
import { LinkDialog, PrintDialog, PropertiesDialog } from "./Dialogs";
import { DocData } from "./docData";
import { Presentation } from "./Presentation";
import { SearchBar } from "./SearchBar";
import { isEmpty, selectionText, type TextSelection } from "./selection";
import { Sidebar, type Panel } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { speechAvailable, useReadAloud } from "./useReadAloud";
import { useSearch } from "./useSearch";

export interface DocumentViewProps {
  info: DocInfo;
  name: string;
  path: string | null;
  fileSize: number;
  active: boolean;
  initialPage: number;
  onPageChange: (page: number) => void;
  onClose: () => void;
}

type DialogState = { kind: "properties" } | { kind: "print" } | { kind: "link"; uri: string } | null;

export function DocumentView(props: DocumentViewProps) {
  const { info, active } = props;
  const data = useMemo(() => new DocData(info.docId), [info.docId]);
  const canvas = useRef<CanvasHandle>(null);

  const [zoomMode, setZoomMode] = useState<ZoomMode>({ kind: "auto" });
  const [rotation, setRotation] = useState<ViewRotation>(0);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => load("layout", "single"));
  const [readingMode, setReadingMode] = useState<ReadingMode>(() => load("readingMode", "normal"));
  const [tool, setTool] = useState<Tool>("select");
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => load("sidebar.open", false));
  const [panel, setPanel] = useState<Panel>(() => load("sidebar.panel", "thumbnails"));
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [currentPage, setCurrentPage] = useState(props.initialPage);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [searchSeed, setSearchSeed] = useState<string | undefined>(undefined);
  const [renderVersion, setRenderVersion] = useState(0);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [presenting, setPresenting] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [status, setStatus] = useState("");
  const history = useRef<{ back: Dest[]; forward: Dest[] }>({ back: [], forward: [] });
  const currentRef = useRef(currentPage);
  currentRef.current = currentPage;

  useEffect(() => save("layout", layoutMode), [layoutMode]);
  useEffect(() => save("readingMode", readingMode), [readingMode]);
  useEffect(() => save("sidebar.open", sidebarOpen), [sidebarOpen]);
  useEffect(() => save("sidebar.panel", panel), [panel]);

  // Navigation data that decides which sidebar panels exist.
  useEffect(() => {
    engine().call("outline", info.docId).then(setOutline, () => {});
    engine().call("attachments", info.docId).then(setAttachments, () => {});
    engine().call("layers", info.docId).then(setLayers, () => {});
  }, [info.docId]);

  // Open at the remembered page.
  useEffect(() => {
    if (props.initialPage > 0 && viewport.height) canvas.current?.scrollTo({ page: props.initialPage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.height > 0]);

  const search = useSearch(info.docId, info.pageCount, useCallback(() => currentRef.current, []));
  const readAloud = useReadAloud(data, info.pageCount, useCallback((p: number) => canvas.current?.scrollTo({ page: p }), []));

  // Status messages fade out on their own.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(""), 2400);
    return () => clearTimeout(t);
  }, [status]);

  // Effective zoom.
  const zoom = useMemo(() => {
    if (zoomMode.kind === "custom") return zoomMode.zoom;
    if (!viewport.width) return 1;
    const { maxRowW, maxGaps } = extents(info.pages, rotation, layoutMode);
    const availW = viewport.width - PAD * 2 - GAP * maxGaps;
    const byWidth = availW / (maxRowW * PT_TO_CSS);
    if (zoomMode.kind === "auto") return clampZoom(Math.min(byWidth, AUTO_MAX));
    if (zoomMode.kind === "fit-width") return clampZoom(byWidth);
    const page = info.pages[currentRef.current] ?? info.pages[0];
    const byHeight = (viewport.height - PAD * 2) / (rotatedSize(page, rotation).height * PT_TO_CSS);
    return clampZoom(Math.min(byWidth, byHeight));
  }, [zoomMode, viewport, info, rotation, layoutMode]);
  const scale = zoom * PT_TO_CSS;

  const zoomStep = useCallback((dir: 1 | -1) => setZoomMode({ kind: "custom", zoom: stepZoom(zoom, dir) }), [zoom]);

  const navigate = useCallback((dest: Dest, opts?: { center?: boolean; noHistory?: boolean }) => {
    const c = canvas.current;
    if (!c) return;
    if (!opts?.noHistory) {
      history.current.back.push(c.here());
      if (history.current.back.length > 100) history.current.back.shift();
      history.current.forward = [];
    }
    c.scrollTo(dest, { center: opts?.center });
  }, []);

  const goHistory = useCallback((dir: "back" | "forward") => {
    const c = canvas.current;
    const h = history.current;
    const from = dir === "back" ? h.back : h.forward;
    const to = dir === "back" ? h.forward : h.back;
    const dest = from.pop();
    if (!dest || !c) return;
    to.push(c.here());
    c.scrollTo(dest);
  }, []);

  const goPage = useCallback((i: number) => navigate({ page: Math.max(0, Math.min(info.pageCount - 1, i)) }), [navigate, info.pageCount]);

  // Bring the current search hit into view.
  const hit = search.state.current != null ? search.state.hits[search.state.current] : null;
  useEffect(() => {
    if (!hit || !hit.rects.length) return;
    const r = hit.rects.reduce<Rect>((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], hit.rects[0]);
    canvas.current?.scrollTo({ page: hit.page, rect: r });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit]);

  const openSearch = useCallback(async (seed?: string) => {
    setSearchOpen(true);
    setSearchFocus((n) => n + 1);
    if (seed !== undefined) setSearchSeed(seed);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchSeed(undefined);
    search.clear();
    canvas.current?.element()?.focus();
  }, [search]);

  useEffect(() => {
    if (search.state.query && sidebarOpen && panel !== "search" && search.state.hits.length > 1) setPanel("search");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.state.query]);

  const copySelection = useCallback(async () => {
    if (!selection || isEmpty(selection)) return;
    if (!info.permissions.copy) {
      setStatus("The author of this document doesn't allow copying.");
      return;
    }
    await copyText(await selectionText(selection, data));
    setStatus("Copied");
  }, [selection, data, info.permissions.copy]);

  const selectAll = useCallback(async () => {
    const last = info.pageCount - 1;
    const layer = await data.textLayer(last);
    setSelection({ anchor: { page: 0, offset: 0 }, focus: { page: last, offset: layer.text.length } });
  }, [data, info.pageCount]);

  const onLink = useCallback(
    (link: LinkInfo) => {
      if (link.dest) navigate({ page: link.dest.page, y: link.dest.y });
      else if (link.uri) setDialog({ kind: "link", uri: link.uri });
    },
    [navigate],
  );

  const onAreaDone = useCallback(
    async (kind: "snapshot" | "marquee", page: number, rect: Rect) => {
      if (kind === "marquee") {
        const v = canvas.current!.viewportSize();
        const size = rotatedSize({ width: rect[2] - rect[0], height: rect[3] - rect[1] }, rotation);
        const z = clampZoom(Math.min((v.width - 32) / (size.width * PT_TO_CSS), (v.height - 32) / (size.height * PT_TO_CSS)));
        canvas.current!.setPendingScroll({ page, rect });
        setZoomMode({ kind: "custom", zoom: z });
        setTool("select");
        return;
      }
      if (!info.permissions.copy) {
        setStatus("The author of this document doesn't allow copying.");
        return;
      }
      // Snapshot: render the area at 2× screen sharpness and put it on the clipboard as a PNG.
      const s = Math.min(scale * (window.devicePixelRatio || 1) * 2, 8);
      const a = toView([rect[0], rect[1]], info.pages[page], rotation);
      const b = toView([rect[2], rect[3]], info.pages[page], rotation);
      const region: Rect = [Math.min(a[0], b[0]) * s, Math.min(a[1], b[1]) * s, Math.max(a[0], b[0]) * s, Math.max(a[1], b[1]) * s];
      try {
        const png = await engine().call("renderImage", { docId: info.docId, pageIndex: page, scale: s, rotation, region }, "png");
        await copyPng(png);
        setStatus("Image copied to the clipboard");
      } catch (err) {
        setStatus(`Couldn't copy the image: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [info, rotation, scale],
  );

  const saveAttachment = useCallback(
    async (name: string) => {
      try {
        const bytes = await engine().call("attachment", info.docId, name);
        if (await saveBytes(name, bytes)) setStatus(`Saved ${name}`);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    },
    [info.docId],
  );

  const toggleLayer = useCallback(
    async (index: number, visible: boolean) => {
      await engine().call("setLayerVisible", info.docId, index, visible);
      setLayers(await engine().call("layers", info.docId));
      setRenderVersion((v) => v + 1);
    },
    [info.docId],
  );

  const startReadAloud = useCallback(() => {
    if (readAloud.status === "idle") void readAloud.start(currentRef.current);
    else readAloud.stop();
  }, [readAloud]);

  // Opening the sidebar during a search shows the results list.
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      if (!o && search.state.query && search.state.hits.length) setPanel("search");
      return !o;
    });
  }, [search.state.query, search.state.hits.length]);

  const doRotate = useCallback((d: 90 | -90) => setRotation((r) => rotate(r, d)), []);

  // Keyboard shortcuts for the active tab. Most follow Acrobat so habits carry over.
  useEffect(() => {
    if (!active || presenting) return;
    const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement)?.tagName ?? "");
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (ctrl && e.shiftKey && (k === "+" || k === "=")) return run(() => doRotate(90));
      if (ctrl && e.shiftKey && (k === "-" || k === "_")) return run(() => doRotate(-90));
      if (ctrl && e.shiftKey && k === "y") return run(startReadAloud);
      if (ctrl && !e.shiftKey && !e.altKey) {
        if (k === "=" || k === "+") return run(() => zoomStep(1));
        if (k === "-") return run(() => zoomStep(-1));
        if (k === "0") return run(() => setZoomMode({ kind: "fit-page" }));
        if (k === "1") return run(() => setZoomMode({ kind: "custom", zoom: 1 }));
        if (k === "2") return run(() => setZoomMode({ kind: "fit-width" }));
        if (k === "f") return run(() => openSearch());
        if (k === "p") return run(() => setDialog({ kind: "print" }));
        if (k === "d") return run(() => setDialog({ kind: "properties" }));
        if (k === "l") return run(() => setPresenting(true));
        if (k === "g") return run(() => document.querySelector<HTMLInputElement>(".doc-view:not([hidden]) .page-input input")?.focus());
        if (k === "c" && !typing() && selection && !isEmpty(selection)) return run(copySelection);
        if (k === "a" && !typing()) return run(selectAll);
      }
      if (e.key === "F3") return run(() => (search.state.hits.length ? search.step(e.shiftKey ? -1 : 1) : openSearch()));
      if (e.key === "F4") return run(toggleSidebar);
      if (e.key === "F5") return run(() => setPresenting(true));
      if (e.altKey && e.key === "ArrowLeft") return run(() => goHistory("back"));
      if (e.altKey && e.key === "ArrowRight") return run(() => goHistory("forward"));
      if (typing() || ctrl || e.altKey) return;
      if (e.key === "Escape") {
        if (tool !== "select") return run(() => setTool("select"));
        if (selection) return run(() => setSelection(null));
      }
      if (k === "v") return run(() => setTool("select"));
      if (k === "h") return run(() => setTool("hand"));
      if (k === "z") return run(() => setTool("marquee"));
      if (k === "g") return run(() => setTool("snapshot"));
      if (e.key === "Home") return run(() => goPage(0));
      if (e.key === "End") return run(() => goPage(info.pageCount - 1));
      if (e.key === "ArrowRight" && zoomMode.kind === "fit-page") return run(() => goPage(currentRef.current + 1));
      if (e.key === "ArrowLeft" && zoomMode.kind === "fit-page") return run(() => goPage(currentRef.current - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, presenting, zoomStep, openSearch, selection, copySelection, selectAll, search, goHistory, tool, goPage, info.pageCount, zoomMode, doRotate, startReadAloud, toggleSidebar]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent, _page: number | null) => {
      const hasSel = !!selection && !isEmpty(selection);
      const entries: MenuEntry[] = [];
      if (hasSel) {
        entries.push({ label: "Copy", shortcut: "Ctrl+C", onSelect: copySelection, disabled: !info.permissions.copy, reason: "The author doesn't allow copying." });
        entries.push({
          label: "Find selected text",
          onSelect: async () => openSearch((await selectionText(selection!, data)).slice(0, 200)),
        });
        entries.push({ kind: "separator" });
      }
      entries.push(
        { label: "Select all", shortcut: "Ctrl+A", onSelect: selectAll },
        { kind: "separator" },
        { label: "Select text", shortcut: "V", checked: tool === "select", onSelect: () => setTool("select") },
        { label: "Hand", shortcut: "H", checked: tool === "hand", onSelect: () => setTool("hand") },
        { label: "Snapshot", shortcut: "G", checked: tool === "snapshot", onSelect: () => setTool("snapshot") },
        { label: "Marquee zoom", shortcut: "Z", checked: tool === "marquee", onSelect: () => setTool("marquee") },
        { kind: "separator" },
        { label: "Rotate clockwise", onSelect: () => doRotate(90) },
        { label: "Rotate counterclockwise", onSelect: () => doRotate(-90) },
        { kind: "separator" },
        { label: "Print…", shortcut: "Ctrl+P", onSelect: () => setDialog({ kind: "print" }) },
        { label: "Document properties", shortcut: "Ctrl+D", onSelect: () => setDialog({ kind: "properties" }) },
      );
      setMenu({ x: e.clientX, y: e.clientY, entries });
    },
    [selection, copySelection, info.permissions.copy, openSearch, data, selectAll, tool, doRotate],
  );

  return (
    <div className="doc-view" hidden={!active}>
      <Toolbar
        info={info}
        currentPage={currentPage}
        zoom={zoom}
        zoomMode={zoomMode}
        layoutMode={layoutMode}
        readingMode={readingMode}
        tool={tool}
        sidebarOpen={sidebarOpen}
        searchOpen={searchOpen}
        speechAvailable={speechAvailable}
        onSidebar={toggleSidebar}
        onTool={setTool}
        onGoPage={goPage}
        onZoomMode={setZoomMode}
        onZoomStep={zoomStep}
        onLayout={setLayoutMode}
        onRotate={doRotate}
        onReadingMode={setReadingMode}
        onSearch={() => (searchOpen ? closeSearch() : openSearch())}
        onPresent={() => setPresenting(true)}
        onReadAloud={startReadAloud}
        onPrint={() => setDialog({ kind: "print" })}
        onProperties={() => setDialog({ kind: "properties" })}
      />
      <div className="doc-view__body">
        {sidebarOpen && (
          <Sidebar
            info={info}
            panel={panel}
            onPanel={setPanel}
            currentPage={currentPage}
            outline={outline}
            attachments={attachments}
            layers={layers}
            search={search.state}
            renderVersion={renderVersion}
            onGo={(d) => navigate(d, { center: !!d.rect })}
            onSelectHit={search.select}
            onSaveAttachment={saveAttachment}
            onToggleLayer={toggleLayer}
          />
        )}
        <div className="doc-view__main">
          <Canvas
            ref={canvas}
            info={info}
            data={data}
            active={active && !presenting}
            scale={scale}
            rotation={rotation}
            mode={layoutMode}
            tool={tool}
            readingMode={readingMode}
            renderVersion={renderVersion}
            hits={search.state.hits}
            currentHit={search.state.current}
            selection={selection}
            onSelection={setSelection}
            onViewport={setViewport}
            onCurrentPage={(p) => {
              setCurrentPage(p);
              props.onPageChange(p);
            }}
            onLink={onLink}
            onAreaDone={onAreaDone}
            onContextMenu={onContextMenu}
            onZoomStep={zoomStep}
          />
          {searchOpen && (
            <SearchBar
              state={search.state}
              pageCount={info.pageCount}
              focusToken={searchFocus}
              initialQuery={searchSeed}
              onRun={search.run}
              onStep={search.step}
              onClose={closeSearch}
            />
          )}
          {readAloud.status !== "idle" && (
            <div className="floating-bar" role="region" aria-label="Read aloud">
              <span>Reading page {readAloud.page + 1}</span>
              {readAloud.status === "playing" ? (
                <button className="icon-button icon-button--sm" aria-label="Pause" onClick={readAloud.pause}>
                  <Pause20Regular />
                </button>
              ) : (
                <button className="icon-button icon-button--sm" aria-label="Resume" onClick={readAloud.resume}>
                  <Play20Regular />
                </button>
              )}
              <select aria-label="Reading speed" className="select" value={readAloud.rate} onChange={(e) => readAloud.setRate(Number(e.target.value))}>
                {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
              <button className="icon-button icon-button--sm" aria-label="Stop reading" onClick={readAloud.stop}>
                <Stop20Regular />
              </button>
            </div>
          )}
          {(tool === "snapshot" || tool === "marquee") && (
            <div className="tool-hint" role="status">
              {tool === "snapshot" ? "Drag over an area to copy it as an image." : "Drag over an area to zoom into it."} <kbd>Esc</kbd> to cancel.
            </div>
          )}
          <div className="status-line" role="status" aria-live="polite" data-visible={!!status}>
            {status}
          </div>
        </div>
      </div>
      {menu && <Menu label="Page" at={menu} entries={menu.entries} onClose={() => setMenu(null)} />}
      {dialog?.kind === "properties" && (
        <PropertiesDialog info={info} name={props.name} path={props.path} fileSize={props.fileSize} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "print" && <PrintDialog info={info} currentPage={currentPage} onClose={() => setDialog(null)} />}
      {dialog?.kind === "link" && (
        <LinkDialog
          uri={dialog.uri}
          onClose={() => setDialog(null)}
          onOpen={() => openExternal(dialog.uri).catch((err) => setStatus(String(err?.message ?? err)))}
        />
      )}
      {presenting && (
        <Presentation
          info={info}
          start={currentPage}
          onExit={(p) => {
            setPresenting(false);
            setTimeout(() => canvas.current?.scrollTo({ page: p }), 0);
          }}
        />
      )}
    </div>
  );
}
