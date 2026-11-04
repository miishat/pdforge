import { Pause20Regular, Play20Regular, Stop20Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { FormSummary, WidgetInfo } from "../../core/forms";
import type { SignatureInfo } from "../../core/signing";
import { rectsForRange } from "../../core/textlayer";
import type { AnnotationInfo, AnnotationPatch, AttachmentInfo, DocInfo, EditState, LayerInfo, LinkInfo, NewAnnotation, OutlineNode, Rect, ViewRotation } from "../../core/types";
import {
  copyPng, copyText, isDesktop, openExternal, pickFile, recoveryClear, recoverySave, saveAs, saveBytes, userName, writePath,
} from "../../platform";
import { AnnotLayer, type Draft } from "./AnnotLayer";
import { CertSignDialog, type CertSignChoice } from "./CertSignDialog";
import { ANNOT_LABELS, CommentsPanel } from "./CommentsPanel";
import { FormLayer } from "./FormLayer";
import { CommentBar, FillBar } from "./ModeBar";
import { SignatureDialog } from "./SignatureDialog";
import { addSignature, dataUrlToBytes, loadSignatures, removeSignature, type SavedSignature } from "./signatures";
import { SignaturesPanel, signatureSummary } from "./SignaturesPanel";
import {
  colorToHex, hexToColor, loadStyles, MARKUP_TOOLS, saveStyles, styleGroup, typeToTool,
  type AnnotTool, type MeasureScale, type Mode, type PlacePayload, type ToolStyle,
} from "./tools";
import { useEditor } from "./useEditor";
import { NotePopover } from "./NotePopover";
import { Menu, type MenuEntry } from "../components/Menu";
import { rotate, rotatedSize, toView } from "../geometry";
import { extents, GAP, PAD, type LayoutMode } from "../layout";
import { load, save } from "../settings";
import { AUTO_MAX, clampZoom, PT_TO_CSS, stepZoom, type ZoomMode } from "../zoom";
import { Canvas, type CanvasHandle, type Dest, type ReadingMode, type Tool } from "./Canvas";
import { FlattenDialog, LinkDialog, MeasureScaleDialog, PrintDialog, PropertiesDialog } from "./Dialogs";
import { DocData } from "./docData";
import { Presentation } from "./Presentation";
import { SearchBar } from "./SearchBar";
import { isEmpty, ordered, rangeOnPage, selectionText, type TextSelection } from "./selection";
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
  /** Unsaved-changes state, for the tab's dot and close prompts. */
  onEditState: (s: EditState) => void;
  /** After Save As: the new location (null path in the browser). */
  onSaved: (path: string | null, name: string) => void;
  /** Lets the app save this document (closing with unsaved changes). Resolves false if cancelled. */
  registerSave: (save: (() => Promise<boolean>) | null) => void;
  /** Crash-recovery key for this tab. */
  recoveryKey: string;
}

type DialogState =
  | { kind: "properties" }
  | { kind: "print" }
  | { kind: "link"; uri: string }
  | { kind: "scale" }
  | { kind: "flatten" }
  | { kind: "newSignature"; sig: "signature" | "initials"; then: boolean }
  | { kind: "cert"; field: WidgetInfo | null }
  | null;

interface Sel {
  page: number;
  id: number;
}

const KEEP_TOOL = new Set<AnnotTool>(["highlight", "underline", "strikeout", "squiggly", "rect", "ellipse", "line", "arrow", "polygon", "polyline", "ink", "distance", "perimeter", "area"]);

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

  // ---- Editing (Phase 2) ----
  const [mode, setModeState] = useState<Mode>("read");
  const [styles, setStyles] = useState(loadStyles);
  const [stamp, setStamp] = useState(() => load("stamp", "Approved"));
  const [measure, setMeasure] = useState<MeasureScale>(() => load("measureScale", { ratio: 1, unit: "in" }));
  const [place, setPlace] = useState<{ key: string; payload: PlacePayload } | null>(null);
  const [selected, setSelected] = useState<Sel | null>(null);
  const [editing, setEditing] = useState<Sel | null>(null);
  const [author, setAuthor] = useState(() => load("author", ""));
  const [signatures, setSignatures] = useState<SavedSignature[]>(loadSignatures);
  const [highlightFields, setHighlightFields] = useState(() => load("highlightFields", true));
  const [formSummary, setFormSummary] = useState<FormSummary>({ fieldCount: 0, hasXfa: false, unsupportedScripts: 0 });
  const [allAnnots, setAllAnnots] = useState<AnnotationInfo[] | null>(null);
  const [sigs, setSigs] = useState<SignatureInfo[] | null>(null);
  const [trusted, setTrusted] = useState<Set<string>>(() => new Set(load<string[]>("trustedSigners", [])));
  const [pendingCert, setPendingCert] = useState<(CertSignChoice & { field: WidgetInfo | null }) | null>(null);
  const newlyCreated = useRef(new Set<number>());

  const showStatus = useCallback((m: string) => setStatus(m), []);
  const editor = useEditor(data, props.onEditState, showStatus);

  useEffect(() => {
    if (!author) void userName().then((n) => setAuthor(n));
  }, [author]);
  useEffect(() => saveStyles(styles), [styles]);
  useEffect(() => save("stamp", stamp), [stamp]);
  useEffect(() => save("measureScale", measure), [measure]);
  useEffect(() => save("highlightFields", highlightFields), [highlightFields]);
  useEffect(() => save("trustedSigners", [...trusted]), [trusted]);
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
    engine().call("formSummary", info.docId).then(setFormSummary, () => {});
    void refreshSignatures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ---- Editing ----

  const refreshSignatures = useCallback(async () => {
    try {
      const list = await engine().call("signatures", info.docId);
      setSigs(list);
    } catch {
      setSigs([]);
    }
  }, [info.docId]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    setTool("select");
    setPlace(null);
    setSelected(null);
    setEditing(null);
    setPendingCert(null);
  }, []);

  const toolStyleKey = (t: Tool) => styleGroup(t);
  const selectedInfo: AnnotationInfo | null = selected ? data.annotsNow(selected.page)?.find((a) => a.id === selected.id) ?? null : null;
  const styleFor = (t: Tool): ToolStyle => styles[toolStyleKey(t)];
  const currentStyle: ToolStyle = selectedInfo
    ? {
        color: colorToHex(selectedInfo.type === "FreeText" ? null : selectedInfo.color) ?? styleFor(typeToTool(selectedInfo.type)).color,
        fill: colorToHex(selectedInfo.interiorColor),
        width: selectedInfo.borderWidth || 1,
        opacity: selectedInfo.opacity,
        fontSize: selectedInfo.fontSize ?? 12,
      }
    : place || (mode === "fill" && tool === "select")
      ? styles.text
      : styleFor(tool);

  const create = useCallback(
    async (page: number, draft: Draft) => {
      const { edit, ...spec } = draft;
      const res = await editor.run(() => engine().call("createAnnotation", info.docId, page, { ...spec, author: author || "Me" } as NewAnnotation));
      if (!res?.id) return;
      if (edit) {
        newlyCreated.current.add(res.id);
        setSelected({ page, id: res.id });
        setEditing({ page, id: res.id });
      }
      // One-shot tools hand back to Select; drawing tools stay active for the next shape.
      if (!KEEP_TOOL.has(tool as AnnotTool) && !(place && place.payload.kind === "mark")) {
        setTool("select");
        setPlace(null);
        if (!edit) setSelected({ page, id: res.id });
      }
    },
    [editor, info.docId, author, tool, place],
  );

  const patch = useCallback(
    (page: number, id: number, p: AnnotationPatch) => void editor.run(() => engine().call("updateAnnotation", info.docId, page, id, p)),
    [editor, info.docId],
  );

  const remove = useCallback(
    async (page: number, id: number) => {
      await editor.run(() => engine().call("deleteAnnotation", info.docId, page, id));
      setSelected((s) => (s?.id === id ? null : s));
      setEditing(null);
    },
    [editor, info.docId],
  );

  const commitText = useCallback(
    async (page: number, id: number, text: string) => {
      setEditing(null);
      const wasNew = newlyCreated.current.delete(id);
      const a = data.annotsNow(page)?.find((x) => x.id === id);
      if (!text.trim() && wasNew && a?.type === "FreeText") return remove(page, id);
      if (a && a.contents === text) return;
      await editor.run(() => engine().call("updateAnnotation", info.docId, page, id, { contents: text }));
    },
    [data, editor, info.docId, remove],
  );

  const applyMarkup = useCallback(
    async (t: AnnotTool, sel: TextSelection) => {
      if (isEmpty(sel)) return;
      const type = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly" }[t as "highlight"];
      const st = styles[styleGroup(t)];
      const [s0, s1] = ordered(sel);
      for (let p = s0.page; p <= s1.page; p++) {
        const layer = await data.textLayer(p);
        const r = rangeOnPage(sel, p, layer);
        if (!r) continue;
        const rects = rectsForRange(layer, r[0], r[1]);
        if (!rects.length) continue;
        const quads = rects.map(([x0, y0, x1, y1]) => [x0, y0, x1, y0, x0, y1, x1, y1] as [number, number, number, number, number, number, number, number]);
        const contents = (await selectionText({ anchor: { page: p, offset: r[0] }, focus: { page: p, offset: r[1] } }, data)).slice(0, 500);
        await editor.run(() =>
          engine().call("createAnnotation", info.docId, p, { type, quads, color: hexToColor(st.color), opacity: st.opacity, author: author || "Me", subject: contents } as NewAnnotation),
        );
      }
      setSelection(null);
    },
    [styles, data, editor, info.docId, author],
  );

  const chooseTool = useCallback(
    (t: Tool) => {
      setPlace(null);
      setSelected(null);
      // Picking a markup tool with text already selected marks that text straight away.
      if (MARKUP_TOOLS.has(t as AnnotTool) && selection && !isEmpty(selection)) {
        void applyMarkup(t as AnnotTool, selection);
        return;
      }
      setTool(t);
    },
    [selection, applyMarkup],
  );

  const changeStyle = useCallback(
    (p: Partial<ToolStyle>) => {
      if (selectedInfo && selected) {
        const ap: AnnotationPatch = {};
        if (p.color) ap.color = hexToColor(p.color);
        if (p.fill !== undefined) ap.interiorColor = p.fill ? hexToColor(p.fill) : null;
        if (p.width !== undefined) ap.borderWidth = p.width;
        if (p.opacity !== undefined) ap.opacity = p.opacity;
        if (p.fontSize !== undefined) ap.fontSize = p.fontSize;
        patch(selected.page, selected.id, ap);
        return;
      }
      const key = place ? "text" : toolStyleKey(tool);
      setStyles((s) => ({ ...s, [key]: { ...s[key], ...p } }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedInfo, selected, patch, place, tool],
  );

  const startPlace = useCallback((key: string, payload: PlacePayload) => {
    setSelected(null);
    setPlace((cur) => (cur?.key === key ? null : { key, payload }));
    setTool((t) => (t === "place" ? "select" : "place"));
    setTool("place");
  }, []);

  const placeSignature = useCallback(
    (s: SavedSignature) => startPlace(`sig-${s.id}`, { kind: "image", png: dataUrlToBytes(s.png), aspect: s.aspect, width: s.kind === "initials" ? 60 : 150, label: s.kind === "initials" ? "Initials" : "Signature" }),
    [startPlace],
  );

  const setField = useCallback(
    async (w: WidgetInfo, value: string) => {
      await editor.run(() => engine().call("setFieldValue", info.docId, w.page, w.id, value));
    },
    [editor, info.docId],
  );

  // Save and Save As. Signatures cover exact bytes, so the engine is told what's now on disk.
  const pathRef = useRef(props.path);
  pathRef.current = props.path;
  const nameRef = useRef(props.name);
  nameRef.current = props.name;

  const writeOut = useCallback(
    async (bytes: Uint8Array, as: boolean): Promise<boolean> => {
      try {
        if (!as && pathRef.current && isDesktop) {
          await writePath(pathRef.current, bytes);
        } else {
          const suggested = nameRef.current.toLowerCase().endsWith(".pdf") ? nameRef.current : `${nameRef.current}.pdf`;
          const path = await saveAs(suggested, bytes);
          if (path === null) return false;
          props.onSaved(path || null, path ? path.split(/[\\/]/).pop()! : suggested);
        }
        await engine().call("setFileBytes", info.docId, bytes);
        void recoveryClear(props.recoveryKey);
        setStatus(`Saved ${nameRef.current}`);
        return true;
      } catch (err) {
        setStatus(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info.docId, props.onSaved, props.recoveryKey],
  );

  const doSave = useCallback(
    async (as = false): Promise<boolean> => {
      const bytes = await engine().call("save", info.docId, { markSaved: false });
      const ok = await writeOut(bytes, as);
      if (ok) {
        await engine().call("save", info.docId, { markSaved: true });
        await editor.refresh();
        void refreshSignatures();
      }
      return ok;
    },
    [info.docId, writeOut, editor, refreshSignatures],
  );

  useEffect(() => {
    props.registerSave(() => doSave(false));
    return () => props.registerSave(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doSave]);

  // Crash recovery: every 30 s, keep a copy of unsaved work.
  const lastAutosave = useRef(-1);
  useEffect(() => {
    if (!isDesktop) return;
    const t = setInterval(async () => {
      if (!editor.state.dirty || lastAutosave.current === data.version) return;
      lastAutosave.current = data.version;
      try {
        const bytes = await engine().call("save", info.docId, { markSaved: false });
        await recoverySave(props.recoveryKey, { name: props.name, path: props.path, savedAt: Date.now() }, bytes);
      } catch {
        /* best effort */
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [editor.state.dirty, data, info.docId, props.recoveryKey, props.name, props.path]);

  const exportComments = useCallback(async () => {
    try {
      const xml = await engine().call("exportXfdf", info.docId, props.name);
      const name = props.name.replace(/\.pdf$/i, "") + ".xfdf";
      const path = await saveAs(name, new TextEncoder().encode(xml), { name: "XFDF comments", extensions: ["xfdf"] });
      if (path !== null) setStatus("Comments exported");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [info.docId, props.name]);

  const importComments = useCallback(async () => {
    const f = await pickFile({ name: "XFDF comments", extensions: ["xfdf", "xml"] });
    if (!f) return;
    const res = await editor.run(() => engine().call("importXfdf", info.docId, new TextDecoder().decode(f.bytes), author || "Me"));
    if (res) setStatus(`Imported ${res.imported} comment${res.imported === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} skipped)` : ""}`);
  }, [editor, info.docId, author]);

  const flatten = useCallback(
    async (what: { annotations: boolean; fields: boolean }) => {
      const res = await editor.run(() => engine().call("flatten", info.docId, what), { text: true });
      if (res) {
        setSelected(null);
        setFormSummary(await engine().call("formSummary", info.docId));
        setStatus("Flattened. Save to keep the change.");
      }
    },
    [editor, info.docId],
  );

  const signWith = useCallback(
    async (choice: CertSignChoice & { field: WidgetInfo | null }, page: number, rect: Rect | undefined) => {
      setPendingCert(null);
      setTool("select");
      setStatus("Signing…");
      try {
        const signed = await engine().call("sign", info.docId, choice.token, {
          pageIndex: page,
          rect,
          reason: choice.reason || undefined,
          location: choice.location || undefined,
          image: choice.image ? dataUrlToBytes(choice.image.png) : undefined,
          fieldId: choice.field?.id,
        });
        void engine().call("forgetIdentity", choice.token);
        data.invalidate(null, { text: true });
        await editor.refresh();
        const base = nameRef.current.replace(/\.pdf$/i, "");
        const suggested = `${base}-signed.pdf`;
        const path = await saveAs(suggested, signed);
        if (path !== null) {
          props.onSaved(path || null, path ? path.split(/[\\/]/).pop()! : suggested);
          await engine().call("save", info.docId, { markSaved: true });
          await editor.refresh();
          setStatus("Signed and saved");
        } else setStatus("Signed. Save the document to keep the signature.");
        void refreshSignatures();
        setSidebarOpen(true);
        setPanel("signatures");
      } catch (err) {
        setStatus(`Couldn't sign: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info.docId, data, editor, refreshSignatures, props.onSaved],
  );

  // Comments list for the sidebar (all pages), refreshed after edits.
  const commentsVisible = sidebarOpen && panel === "comments";
  useEffect(() => {
    if (!commentsVisible) return;
    let alive = true;
    engine().call("annotations", info.docId).then((a) => alive && setAllAnnots(a), () => alive && setAllAnnots([]));
    return () => {
      alive = false;
    };
  }, [commentsVisible, info.docId, data.version]);

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
      if (ctrl && !typing() && k === "z" && !e.shiftKey) return run(() => void editor.undo());
      if (ctrl && !typing() && (k === "y" || (k === "z" && e.shiftKey))) return run(() => void editor.redo());
      if (ctrl && k === "s") return run(() => void doSave(e.shiftKey));
      if (ctrl && e.shiftKey && (k === "1" || k === "!")) return run(() => setMode("read"));
      if (ctrl && e.shiftKey && (k === "2" || k === "@")) return run(() => setMode("comment"));
      if (ctrl && e.shiftKey && (k === "3" || k === "#")) return run(() => setMode("fill"));
      if (!typing() && selected && (e.key === "Delete" || e.key === "Backspace") && mode !== "read") return run(() => void remove(selected.page, selected.id));
      if (!typing() && selected && mode !== "read" && e.key.startsWith("Arrow") && !e.altKey) {
        const d = e.shiftKey ? 10 : 1;
        const t: [number, number] = e.key === "ArrowLeft" ? [-d, 0] : e.key === "ArrowRight" ? [d, 0] : e.key === "ArrowUp" ? [0, -d] : [0, d];
        return run(() => patch(selected.page, selected.id, { translate: t }));
      }
      if (!typing() && e.key === "Escape" && (selected || place || pendingCert)) {
        return run(() => {
          setSelected(null);
          setPlace(null);
          setPendingCert(null);
          if (tool === "place" || tool === "signbox") setTool("select");
        });
      }
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
  }, [active, presenting, zoomStep, openSearch, selection, copySelection, selectAll, search, goHistory, tool, goPage, info.pageCount, zoomMode, doRotate, startReadAloud, toggleSidebar, editor, doSave, setMode, selected, mode, remove, patch, place, pendingCert]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent, _page: number | null) => {
      const hasSel = !!selection && !isEmpty(selection);
      const entries: MenuEntry[] = [];
      if (hasSel) {
        entries.push({ label: "Copy", shortcut: "Ctrl+C", onSelect: copySelection, disabled: !info.permissions.copy, reason: "The author doesn't allow copying." });
        entries.push({ label: "Highlight", onSelect: () => void applyMarkup("highlight", selection!) });
        entries.push({ label: "Underline", onSelect: () => void applyMarkup("underline", selection!) });
        entries.push({ label: "Strike through", onSelect: () => void applyMarkup("strikeout", selection!) });
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
    [selection, copySelection, info.permissions.copy, openSearch, data, selectAll, tool, doRotate, applyMarkup],
  );

  const annotTool: AnnotTool | null =
    tool === "select" || tool === "hand" || tool === "snapshot" || tool === "marquee" || MARKUP_TOOLS.has(tool as AnnotTool) ? null : (tool as AnnotTool);

  const renderOverlay = (page: number, s: number) => {
    void data.pageAnnots(page);
    void data.pageWidgets(page);
    const annots = data.annotsNow(page) ?? [];
    const widgets = data.widgetsNow(page) ?? [];
    const sel = selected?.page === page ? selected.id : null;
    const selInfo = sel != null ? annots.find((a) => a.id === sel) : undefined;
    return (
      <>
        {widgets.length > 0 && (
          <FormLayer
            widgets={widgets}
            size={info.pages[page]}
            rotation={rotation}
            scale={s}
            highlight={highlightFields && mode !== "comment"}
            onSet={setField}
            onInvalid={showStatus}
            onSignField={(w) => setDialog({ kind: "cert", field: w })}
          />
        )}
        <AnnotLayer
          page={page}
          size={info.pages[page]}
          rotation={rotation}
          scale={s}
          annots={annots}
          tool={tool === "signbox" ? "signbox" : annotTool}
          editable={mode !== "read"}
          notesClickable
          style={tool === "place" ? styles.text : styleFor(tool)}
          measure={measure}
          stamp={stamp}
          place={place?.payload ?? null}
          selectedId={sel}
          editingId={editing?.page === page ? editing.id : null}
          onSelect={(pg, id) => {
            setSelected(id == null ? null : { page: pg, id });
            setSelection(null);
          }}
          onCreate={create}
          onPatch={patch}
          onEdit={(pg, id) => setEditing(id == null ? null : { page: pg, id })}
          onCommitText={commitText}
          onSignBox={(pg, rect) => pendingCert && void signWith(pendingCert, pg, rect)}
        />
        {selInfo?.type === "Text" && (
          <NotePopover
            key={selInfo.id}
            annot={selInfo}
            size={info.pages[page]}
            rotation={rotation}
            scale={s}
            editable={mode !== "read"}
            startEditing={editing?.id === selInfo.id}
            onCommit={(text) => void commitText(page, selInfo.id, text)}
            onDelete={() => void remove(page, selInfo.id)}
            onClose={() => setSelected(null)}
            onOpenThread={() => {
              setSidebarOpen(true);
              setPanel("comments");
            }}
          />
        )}
      </>
    );
  };

  const sigSummary = sigs ? signatureSummary(sigs, trusted) : null;
  const deleteSelected = selected && mode !== "read" ? () => void remove(selected.page, selected.id) : null;
  const barCommon = {
    tool,
    onTool: chooseTool,
    canUndo: editor.state.canUndo,
    canRedo: editor.state.canRedo,
    undoLabel: editor.state.undoLabel,
    redoLabel: editor.state.redoLabel,
    onUndo: () => void editor.undo(),
    onRedo: () => void editor.redo(),
    style: currentStyle,
    styleTarget: selectedInfo ? `the selected ${(ANNOT_LABELS[selectedInfo.type] ?? "comment").toLowerCase()}` : "new items",
    showColor: !(selectedInfo && selectedInfo.type === "Stamp") && tool !== "stamp",
    showFill: selectedInfo ? ["Square", "Circle", "Polygon"].includes(selectedInfo.type) : ["rect", "ellipse", "polygon", "area"].includes(tool),
    showFont: selectedInfo ? selectedInfo.type === "FreeText" : ["text", "callout"].includes(tool) || tool === "place",
    showWidth: selectedInfo ? ["Square", "Circle", "Line", "Polygon", "PolyLine", "Ink"].includes(selectedInfo.type) : ["rect", "ellipse", "line", "arrow", "polygon", "polyline", "ink", "distance", "perimeter", "area"].includes(tool),
    onStyle: changeStyle,
    onDeleteSelected: deleteSelected,
  };

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
        mode={mode}
        onMode={setMode}
        onSave={() => void doSave(false)}
        onSaveAs={() => void doSave(true)}
        onExportComments={() => void exportComments()}
        onImportComments={() => void importComments()}
        onFlatten={() => setDialog({ kind: "flatten" })}
      />
      {mode === "comment" && (
        <CommentBar
          {...barCommon}
          stamp={stamp}
          onStamp={setStamp}
          measure={measure}
          onMeasureScale={() => setDialog({ kind: "scale" })}
        />
      )}
      {mode === "fill" && (
        <FillBar
          {...barCommon}
          signatures={signatures}
          placing={place?.key ?? null}
          onPlaceText={() => startPlace("text", { kind: "text", text: "", label: "Text" })}
          onPlaceDate={() => startPlace("date", { kind: "text", text: new Date().toLocaleDateString(), label: "Date" })}
          onPlaceMark={(m) => startPlace(m, { kind: "mark", mark: m, label: m })}
          onPlaceSignature={placeSignature}
          onNewSignature={(k) => setDialog({ kind: "newSignature", sig: k, then: true })}
          onRemoveSignature={(sg) => setSignatures((l) => removeSignature(l, sg.id))}
          onCertSign={() => setDialog({ kind: "cert", field: null })}
          hasForm={formSummary.fieldCount > 0}
          highlightFields={highlightFields}
          onHighlightFields={setHighlightFields}
          onClearForm={() => void editor.run(() => engine().call("resetForm", info.docId))}
        />
      )}
      {formSummary.fieldCount > 0 && mode === "read" && (
        <div className="infobar" role="status">
          This document has fillable form fields.
          {formSummary.unsupportedScripts > 0 && ` ${formSummary.unsupportedScripts} use custom scripts PDForge doesn't run, so some automatic calculations may not update.`}
          <button className="link-button" onClick={() => setMode("fill")}>Fill & Sign</button>
        </div>
      )}
      {sigSummary && (
        <div className={`infobar infobar--${sigSummary.tone}`} role="status">
          {sigSummary.text}
          <button className="link-button" onClick={() => (setSidebarOpen(true), setPanel("signatures"))}>Signature details</button>
        </div>
      )}
      {pendingCert && !pendingCert.field && (
        <div className="infobar infobar--accent" role="status">
          Drag on the page where the signature should appear. <kbd>Esc</kbd> to cancel.
        </div>
      )}
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
            comments={
              <CommentsPanel
                annots={allAnnots}
                labels={info.labels}
                canEdit={mode !== "read" || true}
                selectedId={selected?.id ?? null}
                author={author}
                onGo={(a) => {
                  navigate({ page: a.page, rect: a.rect }, { center: true });
                  if (!a.hidden) setSelected({ page: a.page, id: a.id });
                }}
                onEditContents={(a, t) => patch(a.page, a.id, { contents: t })}
                onReply={(a, t) => void editor.run(() => engine().call("replyToAnnotation", info.docId, a.page, a.id, t, author || "Me"))}
                onStatus={(a, st) => void editor.run(() => engine().call("replyToAnnotation", info.docId, a.page, a.id, `${st} set by ${author || "Me"}`, author || "Me", st))}
                onDelete={(a) => void remove(a.page, a.id)}
              />
            }
            signatures={
              sigs && sigs.length
                ? <SignaturesPanel sigs={sigs} loading={false} trusted={trusted} onGo={(pg) => navigate({ page: pg })} onTrust={(fp, t) => setTrusted((s) => { const n = new Set(s); if (t) n.add(fp); else n.delete(fp); return n; })} />
                : null
            }
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
            renderOverlay={renderOverlay}
            onMarkup={() => selection && MARKUP_TOOLS.has(tool as AnnotTool) && void applyMarkup(tool as AnnotTool, selection)}
            linksEnabled={mode === "read"}
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
      {dialog?.kind === "scale" && <MeasureScaleDialog scale={measure} onSave={setMeasure} onClose={() => setDialog(null)} />}
      {dialog?.kind === "flatten" && <FlattenDialog hasForm={formSummary.fieldCount > 0} onFlatten={(w) => void flatten(w)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "newSignature" && (
        <SignatureDialog
          kind={dialog.sig}
          defaultName={author}
          onClose={() => setDialog(null)}
          onSave={(png, aspect, remember) => {
            const sig = { kind: dialog.sig, png, aspect };
            let saved: SavedSignature;
            if (remember) {
              const next = addSignature(signatures, sig);
              setSignatures(next);
              saved = next.find((x) => x.kind === dialog.sig)!;
            } else saved = { ...sig, id: "temp", createdAt: Date.now() };
            setDialog(null);
            if (dialog.then) placeSignature(saved);
          }}
        />
      )}
      {dialog?.kind === "cert" && (
        <CertSignDialog
          signatures={signatures}
          inField={!!dialog.field}
          onClose={() => setDialog(null)}
          onReady={(choice) => {
            const field = dialog.field;
            setDialog(null);
            if (field) void signWith({ ...choice, field }, field.page, undefined);
            else {
              setPendingCert({ ...choice, field: null });
              setTool("signbox");
            }
          }}
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
