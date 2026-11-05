import { Pause20Regular, Play20Regular, Stop20Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { FormSummary, WidgetInfo } from "../../core/forms";
import type { SignatureInfo } from "../../core/signing";
import { hitRects, rectsForRange } from "../../core/textlayer";
import type { AnnotationInfo, AnnotationPatch, AttachmentInfo, DocInfo, EditState, LayerInfo, LinkInfo, NewAnnotation, OutlineNode, Rect, TextLayer, ViewRotation } from "../../core/types";
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
  colorToHex, EDIT_TOOLS, hexToColor, loadStyles, MARKUP_TOOLS, saveStyles, SELECTION_TOOLS, styleGroup, typeToTool,
  type AnnotTool, type MeasureScale, type Mode, type PlacePayload, type ToolStyle,
} from "./tools";
import { useEditor } from "./useEditor";
import type { TextLine } from "../../core/content";
import type { Point } from "../../core/types";
import { saveFiles, pickFiles, type PickedFile } from "../../platform";
import { EditLayer } from "./EditLayer";
import {
  ApplyRedactionsDialog, BackgroundDialog, FindRedactDialog, HeaderFooterDialog, LinkDialogEdit, SanitizeDialog, WatermarkDialog,
  type HeaderFooterPreset,
} from "./EditDialogs";
import { EditBar, OrganizeBar } from "./ModeBar";
import { ProtectBar, type ProtectDialog } from "./protect/ProtectBar";
import { A11yDialog, TablesDialog } from "./InsightDialogs";
import { AssistantPanel } from "../ai/AssistantPanel";
import { ProtectDialogs, type ProtectContext } from "./protect/ProtectDialogs";
import type { SecurityState } from "../../core/engine";
import { CombineDialog, CropDialog, ExtractDialog, InsertPagesDialog, PageSizeDialog, ReplaceDialog, SplitDialog } from "./OrganizeDialogs";
import { OrganizeView } from "./OrganizeView";
import type { SplitPlan } from "../../core/pages";
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

/** Lets the app read and set where a view is scrolled to (split view's synced scrolling). */
export interface ViewHandle {
  here(): Dest;
  scrollTo(dest: Dest): void;
  scrollTop(): number;
}

/** What a document view offers the app's command dispatcher (palette and shortcuts). */
export interface DocCommands {
  has(id: string): boolean;
  run(id: string): void;
}

export interface DocumentViewProps {
  /** Called with this view's commands while it is the active view, and null when it stops being. */
  registerCommands?: (c: DocCommands | null, previous?: DocCommands) => void;
  /** Shown but not focused (the other half of a split view). */
  visible?: boolean;
  /** Runs an app-level command (palette, split view, compare, batch…). */
  onCommand?: (id: string) => void;
  /** A click in this view when it's visible but not active (split view). */
  onFocusView?: () => void;
  splitSide?: "left" | "right";
  /** For synchronised scrolling in split view. */
  registerView?: (h: ViewHandle | null) => void;
  onViewScroll?: () => void;
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
  /** New page count or sizes after organising pages. */
  onInfo: (info: DocInfo) => void;
  /** Opens bytes as a new, unsaved tab (combined or extracted pages). */
  onOpenNew: (name: string, bytes: Uint8Array) => void;
}

type DialogState =
  | { kind: "properties" }
  | { kind: "print" }
  | { kind: "link"; uri: string }
  | { kind: "scale" }
  | { kind: "flatten" }
  | { kind: "newSignature"; sig: "signature" | "initials"; then: boolean }
  | { kind: "cert"; field: WidgetInfo | null }
  | { kind: "insertPages" }
  | { kind: "extract" }
  | { kind: "split" }
  | { kind: "crop" }
  | { kind: "pageSize" }
  | { kind: "replace" }
  | { kind: "combine"; files: PickedFile[] }
  | { kind: "headerFooter"; preset: HeaderFooterPreset }
  | { kind: "watermark" }
  | { kind: "background" }
  | { kind: "addLink"; page: number; rect: Rect }
  | { kind: "findRedact" }
  | { kind: "applyRedactions" }
  | { kind: "sanitize" }
  | { kind: "tables" }
  | { kind: "a11y" }
  | null;

interface Sel {
  page: number;
  id: number;
}

const KEEP_TOOL = new Set<AnnotTool>(["highlight", "underline", "strikeout", "squiggly", "rect", "ellipse", "line", "arrow", "polygon", "polyline", "ink", "distance", "perimeter", "area"]);

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip", json: "application/json", xml: "application/xml",
  };
  return map[ext] ?? "application/octet-stream";
}

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
  const [protectDialog, setProtectDialog] = useState<ProtectDialog | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [security, setSecurity] = useState<SecurityState | null>(null);
  const [repairedNotice, setRepairedNotice] = useState(info.repaired);
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
  // Organize and Edit modes.
  const [orgSelected, setOrgSelected] = useState<Set<number>>(() => new Set());
  const [orgZoom, setOrgZoom] = useState(() => load("organizeZoom", 170));
  const [editImage, setEditImage] = useState<{ page: number; index: number } | null>(null);
  const [editLink, setEditLink] = useState<{ page: number; index: number } | null>(null);
  const [textFont, setTextFont] = useState<{ family: "sans" | "serif" | "mono"; bold: boolean; italic: boolean }>({ family: "sans", bold: false, italic: false });
  const [markKinds, setMarkKinds] = useState<string[]>([]);
  const [redactCount, setRedactCount] = useState(0);
  const infoRef = useRef(info);
  infoRef.current = info;

  const showStatus = useCallback((m: string) => setStatus(m), []);
  const editor = useEditor(data, props.onEditState, showStatus, async () => {
    const next = await engine().call("info", info.docId);
    props.onInfo(next);
    setOrgSelected((sel) => new Set([...sel].filter((i) => i < next.pageCount)));
  });
  useEffect(() => save("organizeZoom", orgZoom), [orgZoom]);
  useEffect(() => {
    if (mode !== "edit") return;
    engine().call("markKinds", info.docId).then(setMarkKinds, () => {});
    engine().call("redactionMarkCount", info.docId).then(setRedactCount, () => {});
  }, [mode, info.docId, data.version]);

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

  // Status messages fade out on their own, after enough time to read them.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(""), Math.min(9000, Math.max(2400, status.length * 60)));
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
    if (!hit) return;
    let live = true;
    const go = (layer: TextLayer | undefined) => {
      const rects = layer ? hitRects(hit, layer) : hit.rects;
      if (!live) return;
      if (!rects.length) return canvas.current?.scrollTo({ page: hit.page });
      const r = rects.reduce<Rect>((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], rects[0]);
      canvas.current?.scrollTo({ page: hit.page, rect: r });
    };
    // The position of a hit is worked out from the page's text layer, which may still be loading.
    const now = data.textLayerNow(hit.page);
    if (now || hit.rects.length) go(now);
    else data.textLayer(hit.page).then(go, () => go(undefined));
    return () => void (live = false);
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
    setModeState((prev) => {
      if (prev === "organize" && m !== "organize") {
        const first = [...orgSelectedRef.current].sort((a, b) => a - b)[0];
        if (first != null) setTimeout(() => canvas.current?.scrollTo({ page: first }), 0);
      }
      if (m === "organize") setOrgSelected(new Set([currentRef.current]));
      return m;
    });
    setEditImage(null);
    setEditLink(null);
    setTool("select");
    setPlace(null);
    setSelected(null);
    setEditing(null);
    setPendingCert(null);
  }, []);

  const orgSelectedRef = useRef(orgSelected);
  orgSelectedRef.current = orgSelected;
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
      if (t === "redacttext") {
        const [a0, a1] = ordered(sel);
        const items: { page: number; quads: [number, number, number, number, number, number, number, number][] }[] = [];
        for (let p = a0.page; p <= a1.page; p++) {
          const layer = await data.textLayer(p);
          const r = rangeOnPage(sel, p, layer);
          if (!r) continue;
          const rects = rectsForRange(layer, r[0], r[1]);
          if (rects.length) items.push({ page: p, quads: rects.map(([x0, y0, x1, y1]) => [x0, y0, x1, y0, x0, y1, x1, y1]) });
        }
        if (items.length) await editor.run(() => engine().call("markForRedaction", info.docId, items));
        setSelection(null);
        return;
      }
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

  // ---- Organize ----

  const orgList = [...orgSelected].sort((a, b) => a - b);
  const insertAt = () => (orgList.length ? orgList[orgList.length - 1] + 1 : info.pageCount);

  const movePagesTo = useCallback(
    async (pages: number[], to: number) => {
      const res = await editor.run(() => engine().call("movePages", info.docId, pages, to), { text: true });
      if (res) {
        const start = Array.from({ length: infoRef.current.pageCount }, (_, i) => i).filter((i) => !pages.includes(i) && i < to).length;
        setOrgSelected(new Set(pages.map((_, k) => start + k)));
      }
    },
    [editor, info.docId],
  );

  const pageOp = useCallback(
    async (op: () => Promise<unknown>, after?: () => void) => {
      const res = await editor.run(op as () => Promise<{ pages: null }>, { text: true });
      if (res) after?.();
      return res;
    },
    [editor],
  );

  const extract = useCallback(
    async (pages: number[], opts: { separate: boolean; remove: boolean; open: boolean }) => {
      const base = props.name.replace(/\.pdf$/i, "");
      try {
        if (opts.separate) {
          const files = [];
          for (const p of pages) files.push({ name: `${base} - page ${p + 1}.pdf`, bytes: await engine().call("extractPages", info.docId, [p]) });
          const n = await saveFiles(files);
          if (n === null) return;
          setStatus(`Saved ${n} file${n === 1 ? "" : "s"}`);
        } else {
          const bytes = await engine().call("extractPages", info.docId, pages);
          const name = `${base} (pages ${pages.length === 1 ? pages[0] + 1 : `${pages[0] + 1}-${pages[pages.length - 1] + 1}`}).pdf`;
          if (opts.open) props.onOpenNew(name, bytes);
          else if ((await saveAs(name, bytes)) === null) return;
        }
        if (opts.remove) await pageOp(() => engine().call("deletePages", info.docId, pages), () => setOrgSelected(new Set()));
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info.docId, props.name, pageOp],
  );

  const split = useCallback(
    async (plan: SplitPlan) => {
      try {
        const parts = await engine().call("splitDocument", info.docId, plan);
        const base = props.name.replace(/\.pdf$/i, "");
        const n = await saveFiles(parts.map((p, i) => ({ name: `${base} - ${String(i + 1).padStart(2, "0")} ${p.label}.pdf`, bytes: p.bytes })));
        if (n !== null) setStatus(`Split into ${n} files`);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    },
    [info.docId, props.name],
  );

  const openCombine = useCallback(async () => {
    const current = await engine().call("save", info.docId, { markSaved: false });
    setDialog({ kind: "combine", files: [{ name: props.name, path: props.path, bytes: current }] });
  }, [info.docId, props.name, props.path]);

  // ---- Edit ----

  const editLine = useCallback(
    async (page: number, line: TextLine, text: string) => {
      const res = await editor.run(() => engine().call("replaceLine", info.docId, page, line.index, line.text, text), { text: true });
      if (res?.lossy) setStatus("Some characters couldn't be shown in the available fonts.");
      else if (res?.substituted && text.trim()) setStatus(`The original font doesn't include these characters, so ${res.usedFont} was used.`);
    },
    [editor, info.docId],
  );

  const addPageText = useCallback(
    async (page: number, origin: Point, text: string) => {
      const st = styles.text;
      const res = await editor.run(() => engine().call("addText", info.docId, page, origin, text, { size: st.fontSize, color: hexToColor(st.color), ...textFont }), { text: true });
      if (res?.lossy) setStatus("Some characters couldn't be shown in the standard fonts.");
    },
    [editor, info.docId, styles.text, textFont],
  );

  const pickImage = () => pickFile({ name: "Images", extensions: ["png", "jpg", "jpeg"] });

  const deleteSelectedEditItem = useCallback(async () => {
    if (editImage) {
      await editor.run(() => engine().call("deleteImage", info.docId, editImage.page, editImage.index));
      setEditImage(null);
    } else if (editLink) {
      await editor.run(() => engine().call("deleteLink", info.docId, editLink.page, editLink.index));
      setEditLink(null);
    }
  }, [editImage, editLink, editor, info.docId]);

  // Keyboard shortcuts for the active tab. Most follow Acrobat so habits carry over.
  useEffect(() => {
    if (!active || presenting) return;
    const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement)?.tagName ?? "");
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (e.defaultPrevented) return;
      if (!typing() && mode === "organize") {
        if ((e.key === "Delete" || e.key === "Backspace") && orgSelected.size && orgSelected.size < info.pageCount)
          return run(() => void pageOp(() => engine().call("deletePages", info.docId, [...orgSelected]), () => setOrgSelected(new Set())));
      }
      if (!typing() && mode === "edit" && (editImage || editLink) && (e.key === "Delete" || e.key === "Backspace")) return run(() => void deleteSelectedEditItem());
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
      if (typing() || ctrl || e.altKey) return;
      if (e.key === "Escape") {
        if (tool !== "select") return run(() => setTool("select"));
        if (selection) return run(() => setSelection(null));
      }
      if (e.key === "ArrowRight" && zoomMode.kind === "fit-page") return run(() => goPage(currentRef.current + 1));
      if (e.key === "ArrowLeft" && zoomMode.kind === "fit-page") return run(() => goPage(currentRef.current - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, presenting, zoomStep, openSearch, selection, copySelection, selectAll, search, goHistory, tool, goPage, info.pageCount, zoomMode, doRotate, startReadAloud, toggleSidebar, editor, doSave, setMode, selected, mode, remove, patch, place, pendingCert, orgSelected, pageOp, editImage, editLink, deleteSelectedEditItem]);

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

  // Commands for the palette and the app's shortcut dispatcher. Missing entries are unavailable
  // right now (so the key falls through, e.g. Ctrl+C with nothing selected).
  const commandsRef = useRef<Record<string, (() => void) | undefined>>({});
  const scroller = () => canvas.current?.element();
  const scrollBy = (dy: number) => scroller()?.scrollBy({ top: dy });
  const openProtect = (d: ProtectDialog) => {
    setMode("protect");
    setProtectDialog(d);
  };
  commandsRef.current = {
    "file.save": () => void doSave(false),
    "file.saveAs": () => void doSave(true),
    "file.print": () => setDialog({ kind: "print" }),
    "file.properties": () => setDialog({ kind: "properties" }),
    "file.export": () => setProtectDialog({ kind: "export", format: "docx" }),
    "file.exportComments": () => void exportComments(),
    "file.importComments": () => void importComments(),
    "edit.flatten": () => setDialog({ kind: "flatten" }),
    "edit.tables": () => setDialog({ kind: "tables" }),
    "edit.undo": editor.state.canUndo ? () => void editor.undo() : undefined,
    "edit.redo": editor.state.canRedo ? () => void editor.redo() : undefined,
    "edit.copy": selection && !isEmpty(selection) ? () => void copySelection() : undefined,
    "edit.selectAll": mode === "organize" ? () => setOrgSelected(new Set(info.pages.map((_, i) => i))) : () => void selectAll(),
    "view.zoomIn": () => zoomStep(1),
    "view.zoomOut": () => zoomStep(-1),
    "view.fitPage": () => setZoomMode({ kind: "fit-page" }),
    "view.actualSize": () => setZoomMode({ kind: "custom", zoom: 1 }),
    "view.fitWidth": () => setZoomMode({ kind: "fit-width" }),
    "view.rotateCw": () => doRotate(90),
    "view.rotateCcw": () => doRotate(-90),
    "view.sidebar": toggleSidebar,
    "view.present": () => setPresenting(true),
    "view.readAloud": startReadAloud,
    "nav.find": () => void openSearch(),
    "nav.findNext": () => (search.state.hits.length ? search.step(1) : void openSearch()),
    "nav.findPrev": () => (search.state.hits.length ? search.step(-1) : void openSearch()),
    "nav.goto": () => document.querySelector<HTMLInputElement>(".doc-view--active .page-input input")?.focus(),
    "nav.first": () => goPage(0),
    "nav.last": () => goPage(info.pageCount - 1),
    "nav.back": () => goHistory("back"),
    "nav.forward": () => goHistory("forward"),
    "tool.select": () => setTool("select"),
    "tool.hand": () => setTool("hand"),
    "tool.marquee": () => setTool("marquee"),
    "tool.snapshot": () => setTool("snapshot"),
    "mode.read": () => setMode("read"),
    "mode.comment": () => setMode("comment"),
    "mode.fill": () => setMode("fill"),
    "mode.organize": () => setMode("organize"),
    "mode.edit": () => setMode("edit"),
    "mode.protect": () => setMode("protect"),
    "protect.security": () => openProtect({ kind: "security" }),
    "protect.ocr": () => openProtect({ kind: "ocr" }),
    "protect.compress": () => openProtect({ kind: "compress" }),
    "protect.pdfa": () => openProtect({ kind: "pdfa" }),
    "protect.repair": () => openProtect({ kind: "repair" }),
    "protect.a11y": () => setDialog({ kind: "a11y" }),
    "window.assistant": () => setAssistantOpen((o) => !o),
    // Vim-style navigation (the app routes these keys here only when the option is on).
    "vim.down": () => scrollBy(60),
    "vim.up": () => scrollBy(-60),
    "vim.halfDown": () => scrollBy((scroller()?.clientHeight ?? 600) / 2),
    "vim.halfUp": () => scrollBy(-(scroller()?.clientHeight ?? 600) / 2),
    "vim.prevPage": () => goPage(currentRef.current - 1),
    "vim.nextPage": () => goPage(currentRef.current + 1),
    "vim.first": () => goPage(0),
    "vim.last": () => goPage(info.pageCount - 1),
    "vim.find": () => void openSearch(),
    "vim.next": () => search.state.hits.length && search.step(1),
    "vim.prev": () => search.state.hits.length && search.step(-1),
  };
  const { registerView, onViewScroll } = props;
  useEffect(() => {
    if (!registerView) return;
    registerView({
      here: () => canvas.current?.here() ?? { page: 0 },
      scrollTo: (d) => canvas.current?.scrollTo(d),
      scrollTop: () => canvas.current?.element()?.scrollTop ?? 0,
    });
    return () => registerView(null);
    // Registered once per view; the handle reads the canvas when called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const el = canvas.current?.element();
    if (!el || !onViewScroll || !props.visible) return;
    el.addEventListener("scroll", onViewScroll, { passive: true });
    return () => el.removeEventListener("scroll", onViewScroll);
  }, [onViewScroll, props.visible]);
  const registerCommands = props.registerCommands;
  useEffect(() => {
    if (!active || !registerCommands || presenting) return;
    const c: DocCommands = { has: (id) => !!commandsRef.current[id], run: (id) => commandsRef.current[id]?.() };
    registerCommands(c);
    return () => registerCommands(null, c);
  }, [active, registerCommands, presenting]);

  const annotTool: AnnotTool | null =
    tool === "select" || tool === "hand" || tool === "snapshot" || tool === "marquee" || SELECTION_TOOLS.has(tool as AnnotTool) || EDIT_TOOLS.has(tool as AnnotTool)
      ? null
      : (tool as AnnotTool);

  const renderOverlay = (page: number, s: number) => {
    void data.pageAnnots(page);
    void data.pageWidgets(page);
    const allAnnots = data.annotsNow(page) ?? [];
    // In Edit mode only redaction marks are selectable; comments are left alone.
    const annots = mode === "edit" ? allAnnots.filter((a) => a.type === "Redact") : allAnnots;
    const editTool = mode === "edit" && EDIT_TOOLS.has(tool as AnnotTool) ? (tool as AnnotTool) : null;
    if (editTool === "edittext") void data.pageLines(page);
    if (editTool === "editimage") void data.pageImages(page);
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
          tool={tool === "signbox" ? "signbox" : mode === "edit" ? (tool === "redactarea" ? null : null) : annotTool}
          editable={mode !== "read" && !(mode === "edit" && tool !== "select")}
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
        {editTool && (
          <EditLayer
            page={page}
            size={info.pages[page]}
            rotation={rotation}
            scale={s}
            tool={editTool}
            lines={data.linesNow(page) ?? []}
            images={data.imagesNow(page) ?? []}
            links={data.linksNow(page) ?? []}
            selectedImage={editImage?.page === page ? editImage.index : null}
            selectedLink={editLink?.page === page ? editLink.index : null}
            textStyle={{ size: styles.text.fontSize, color: styles.text.color, ...textFont }}
            onEditLine={editLine}
            onAddText={addPageText}
            onSelectImage={(pg, i) => setEditImage(i == null ? null : { page: pg, index: i })}
            onMoveImage={(pg, i, r) => void editor.run(() => engine().call("moveImage", info.docId, pg, i, r)).then(() => setEditImage(null))}
            onAddImageArea={async (pg, r) => {
              const f = await pickImage();
              if (f) await editor.run(() => engine().call("insertImage", info.docId, pg, r, f.bytes));
            }}
            onSelectLink={(pg, i) => setEditLink(i == null ? null : { page: pg, index: i })}
            onLinkArea={(pg, r) => setDialog({ kind: "addLink", page: pg, rect: r })}
            onRedactArea={(pg, r) => void editor.run(() => engine().call("markForRedaction", info.docId, [{ page: pg, rect: r }]))}
          />
        )}
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
  const refreshSecurity = useCallback(async () => {
    setSecurity(await engine().call("security", info.docId).catch(() => null));
  }, [info.docId]);
  useEffect(() => {
    if (mode === "protect") void refreshSecurity();
  }, [mode, editor.state, refreshSecurity]);
  const protectCtx: ProtectContext = {
    info,
    name: props.name,
    currentPage,
    signed: !!sigs?.length,
    run: editor.run,
    undo: editor.undo,
    refresh: async () => {
      await editor.refresh();
      await refreshSecurity();
    },
    setStatus,
  };

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
    showFont: selectedInfo ? selectedInfo.type === "FreeText" : ["text", "callout", "addtext"].includes(tool) || tool === "place",
    showWidth: selectedInfo ? ["Square", "Circle", "Line", "Polygon", "PolyLine", "Ink"].includes(selectedInfo.type) : ["rect", "ellipse", "line", "arrow", "polygon", "polyline", "ink", "distance", "perimeter", "area"].includes(tool),
    onStyle: changeStyle,
    onDeleteSelected: deleteSelected,
  };

  return (
    <div className={`doc-view ${active ? "doc-view--active" : ""} ${props.splitSide ? `doc-view--${props.splitSide}` : ""}`} hidden={!active && !props.visible} onPointerDownCapture={props.onFocusView}>
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
        onExport={() => setProtectDialog({ kind: "export", format: "docx" })}
        onCommand={(id) => (commandsRef.current[id] ? commandsRef.current[id]!() : props.onCommand?.(id))}
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
      {mode === "organize" && (
        <OrganizeBar
          selected={orgSelected.size}
          pageCount={info.pageCount}
          canUndo={editor.state.canUndo}
          canRedo={editor.state.canRedo}
          undoLabel={editor.state.undoLabel}
          redoLabel={editor.state.redoLabel}
          onUndo={() => void editor.undo()}
          onRedo={() => void editor.redo()}
          onInsertBlank={() => {
            const ref = info.pages[orgList[orgList.length - 1] ?? 0] ?? { width: 612, height: 792 };
            const at = insertAt();
            void pageOp(() => engine().call("insertBlankPage", info.docId, at, [ref.width, ref.height]), () => setOrgSelected(new Set([at])));
          }}
          onInsertFile={() => setDialog({ kind: "insertPages" })}
          onInsertImage={async () => {
            const files = await pickFiles({ name: "Images", extensions: ["png", "jpg", "jpeg"] });
            let at = insertAt();
            for (const f of files) {
              const pos = at++;
              await pageOp(() => engine().call("insertImagePage", info.docId, pos, f.bytes));
            }
          }}
          onRotate={(by) => void pageOp(() => engine().call("rotatePages", info.docId, orgList, by))}
          onDelete={() => void pageOp(() => engine().call("deletePages", info.docId, orgList), () => setOrgSelected(new Set()))}
          onDuplicate={() => void pageOp(() => engine().call("duplicatePages", info.docId, orgList))}
          onExtract={() => setDialog({ kind: "extract" })}
          onReplace={() => setDialog({ kind: "replace" })}
          onSplit={() => setDialog({ kind: "split" })}
          onCrop={() => setDialog({ kind: "crop" })}
          onPageSize={() => setDialog({ kind: "pageSize" })}
          onCombine={() => void openCombine()}
          onSelectAll={() => setOrgSelected(new Set(info.pages.map((_, i) => i)))}
          zoom={orgZoom}
          onZoom={setOrgZoom}
        />
      )}
      {mode === "edit" && (
        <EditBar
          {...barCommon}
          markKinds={markKinds}
          redactions={redactCount}
          imageSelected={!!editImage}
          linkSelected={!!editLink}
          textStyle={textFont}
          onTextStyle={(st) => setTextFont((f) => ({ ...f, ...st }))}
          onReplaceImage={async () => {
            const f = await pickImage();
            if (f && editImage) {
              await editor.run(() => engine().call("replaceImage", info.docId, editImage.page, editImage.index, f.bytes));
              setEditImage(null);
            }
          }}
          onDeleteImage={() => void deleteSelectedEditItem()}
          onDeleteLink={() => void deleteSelectedEditItem()}
          onHeaderFooter={(preset) => setDialog({ kind: "headerFooter", preset })}
          onWatermark={() => setDialog({ kind: "watermark" })}
          onBackground={() => setDialog({ kind: "background" })}
          onRemoveMarks={(k) => void editor.run(() => engine().call("removeMarks", info.docId, k), { text: true })}
          onFindRedact={() => setDialog({ kind: "findRedact" })}
          onApplyRedactions={() => setDialog({ kind: "applyRedactions" })}
          onSanitize={() => setDialog({ kind: "sanitize" })}
        />
      )}
      {mode === "protect" && (
        <ProtectBar
          security={security}
          canUndo={editor.state.canUndo}
          canRedo={editor.state.canRedo}
          undoLabel={editor.state.undoLabel}
          redoLabel={editor.state.redoLabel}
          onUndo={() => void editor.undo()}
          onRedo={() => void editor.redo()}
          onOpen={setProtectDialog}
          onTables={() => setDialog({ kind: "tables" })}
          onA11y={() => setDialog({ kind: "a11y" })}
        />
      )}
      {repairedNotice && (
        <div className="infobar" role="status">
          This file was damaged. PDForge repaired it while opening; save to keep the repaired version.
          <button className="link-button" onClick={() => (setRepairedNotice(false), setProtectDialog({ kind: "repair" }))}>Details</button>
          <button className="link-button" onClick={() => setRepairedNotice(false)}>Dismiss</button>
        </div>
      )}
      {mode === "edit" && redactCount > 0 && (
        <div className="infobar infobar--bad" role="status">
          {redactCount} area{redactCount === 1 ? " is" : "s are"} marked for redaction. Nothing is removed until you apply them.
          <button className="link-button" onClick={() => setDialog({ kind: "applyRedactions" })}>Apply redactions…</button>
        </div>
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
            data={data}
            onSetOutline={async (nodes) => {
              const r = await editor.run(() => engine().call("setOutline", info.docId, nodes));
              if (r) setOutline(await engine().call("outline", info.docId));
            }}
            suggestBookmarkTitle={async () => (selection && !isEmpty(selection) ? (await selectionText(selection, data)).split("\n")[0].slice(0, 80) : null)}
            onAddAttachment={async () => {
              const f = await pickFile({ name: "Any file", extensions: ["*"] });
              if (!f) return;
              const r = await editor.run(() => engine().call("addAttachment", info.docId, f.name, guessMime(f.name), f.bytes));
              if (r) setAttachments(await engine().call("attachments", info.docId));
            }}
            onDeleteAttachment={async (name) => {
              const r = await editor.run(() => engine().call("deleteAttachment", info.docId, name));
              if (r) setAttachments(await engine().call("attachments", info.docId));
            }}
            attachmentsAlways={mode === "edit"}
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
          {mode === "organize" && (
            <OrganizeView
              info={info}
              data={data}
              selected={orgSelected}
              onSelect={setOrgSelected}
              onMove={(pages, to) => void movePagesTo(pages, to)}
              onOpen={(pg) => {
                setOrgSelected(new Set([pg]));
                setMode("read");
                setTimeout(() => canvas.current?.scrollTo({ page: pg }), 0);
              }}
              onContextMenu={(e) => {
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  entries: [
                    { label: "Rotate right", onSelect: () => void pageOp(() => engine().call("rotatePages", info.docId, [...orgSelectedRef.current], 90)) },
                    { label: "Rotate left", onSelect: () => void pageOp(() => engine().call("rotatePages", info.docId, [...orgSelectedRef.current], -90)) },
                    { label: "Duplicate", onSelect: () => void pageOp(() => engine().call("duplicatePages", info.docId, [...orgSelectedRef.current])) },
                    { label: "Extract…", onSelect: () => setDialog({ kind: "extract" }) },
                    { kind: "separator" },
                    { label: "Insert blank page after", onSelect: () => {
                      const at = Math.max(...orgSelectedRef.current) + 1;
                      const ref = info.pages[at - 1];
                      void pageOp(() => engine().call("insertBlankPage", info.docId, at, [ref.width, ref.height]));
                    } },
                    { kind: "separator" },
                    { label: "Delete", shortcut: "Del", disabled: orgSelectedRef.current.size >= info.pageCount, onSelect: () => void pageOp(() => engine().call("deletePages", info.docId, [...orgSelectedRef.current]), () => setOrgSelected(new Set())) },
                  ],
                });
              }}
              size={orgZoom}
            />
          )}
          {mode !== "organize" && <Canvas
            ref={canvas}
            info={info}
            data={data}
            active={(active || !!props.visible) && !presenting}
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
            onMarkup={() => selection && SELECTION_TOOLS.has(tool as AnnotTool) && void applyMarkup(tool as AnnotTool, selection)}
            linksEnabled={mode === "read"}
          />}
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
        {assistantOpen && (
          <AssistantPanel info={info} name={props.name} currentPage={currentPage} onClose={() => setAssistantOpen(false)} onGoPage={goPage} run={editor.run} />
        )}
      </div>
      {menu && <Menu label="Page" at={menu} entries={menu.entries} onClose={() => setMenu(null)} />}
      {dialog?.kind === "properties" && (
        <PropertiesDialog
          info={info}
          name={props.name}
          path={props.path}
          fileSize={props.fileSize}
          onClose={() => setDialog(null)}
          onSaveMetadata={async (fields) => void (await editor.run(() => engine().call("setMetadata", info.docId, fields)))}
        />
      )}
      {dialog?.kind === "print" && <PrintDialog info={info} currentPage={currentPage} onClose={() => setDialog(null)} />}
      {dialog?.kind === "link" && (
        <LinkDialog
          uri={dialog.uri}
          onClose={() => setDialog(null)}
          onOpen={() => openExternal(dialog.uri).catch((err) => setStatus(String(err?.message ?? err)))}
        />
      )}
      {dialog?.kind === "insertPages" && (
        <InsertPagesDialog
          count={info.pageCount}
          at={orgList[orgList.length - 1] ?? currentPage}
          onClose={() => setDialog(null)}
          onInsert={async (file, pages, at, password) => {
            try {
              await engine().call("insertPagesFrom", info.docId, at, file.bytes.slice(), pages, password).then(async (r) => {
                data.invalidate(null, { text: true });
                props.onInfo(await engine().call("info", info.docId));
                await editor.refresh();
                setOrgSelected(new Set(Array.from({ length: r.inserted }, (_, i) => at + i)));
              });
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          }}
        />
      )}
      {dialog?.kind === "extract" && <ExtractDialog count={info.pageCount} selected={orgList.length ? orgList : [currentPage]} onExtract={(p, o) => void extract(p, o)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "split" && <SplitDialog count={info.pageCount} hasOutline={outline.length > 0} onSplit={(plan) => void split(plan)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "crop" && (
        <CropDialog
          count={info.pageCount}
          selected={mode === "organize" ? orgList : [currentPage]}
          onCrop={(pages, m) => void pageOp(() => engine().call("cropPages", info.docId, pages, m))}
          onCropContent={(pages) => void pageOp(() => engine().call("cropToContent", info.docId, pages))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "pageSize" && <PageSizeDialog count={info.pageCount} selected={mode === "organize" ? orgList : [currentPage]} onResize={(pages, size, sc) => void pageOp(() => engine().call("resizePages", info.docId, pages, size, sc))} onClose={() => setDialog(null)} />}
      {dialog?.kind === "replace" && (
        <ReplaceDialog
          selected={orgList}
          onClose={() => setDialog(null)}
          onReplace={async (file, src, password) => {
            try {
              await engine().call("replacePages", info.docId, orgList, file.bytes.slice(), src, password);
              data.invalidate(null, { text: true });
              props.onInfo(await engine().call("info", info.docId));
              await editor.refresh();
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          }}
        />
      )}
      {dialog?.kind === "combine" && (
        <CombineDialog
          initial={dialog.files}
          onClose={() => setDialog(null)}
          onCombine={async (files, bookmarks) => {
            try {
              const bytes = await engine().call("mergeFiles", files.map((f) => ({ name: f.name, bytes: f.bytes.slice() })), bookmarks);
              props.onOpenNew("Combined.pdf", bytes);
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          }}
        />
      )}
      {dialog?.kind === "headerFooter" && (
        <HeaderFooterDialog
          preset={dialog.preset}
          count={info.pageCount}
          selected={[currentPage]}
          fileName={props.name}
          onClose={() => setDialog(null)}
          onApply={async (spec) => {
            const r = await editor.run(() => engine().call("addHeaderFooter", info.docId, spec), { text: true });
            if (r?.lossy) setStatus("Some characters can't be shown in the header font (Helvetica) and were replaced with \"?\".");
          }}
        />
      )}
      {dialog?.kind === "watermark" && (
        <WatermarkDialog
          count={info.pageCount}
          selected={[currentPage]}
          onClose={() => setDialog(null)}
          onApply={async (spec) => {
            const r = await editor.run(() => engine().call("addWatermark", info.docId, spec), { text: true });
            if (r?.lossy) setStatus("Some characters can't be shown in the watermark font and were replaced with \"?\".");
          }}
        />
      )}
      {dialog?.kind === "background" && <BackgroundDialog count={info.pageCount} selected={[currentPage]} onClose={() => setDialog(null)} onApply={(spec) => void editor.run(() => engine().call("addBackground", info.docId, spec))} />}
      {dialog?.kind === "addLink" && (
        <LinkDialogEdit count={info.pageCount} onClose={() => setDialog(null)} onSave={(target) => void editor.run(() => engine().call("addLink", info.docId, dialog.page, dialog.rect, target))} />
      )}
      {dialog?.kind === "findRedact" && (
        <FindRedactDialog
          docId={info.docId}
          onClose={() => setDialog(null)}
          onMark={async (hits) => {
            const items = hits.map((h) => ({ page: h.page, quads: h.rects.map(([x0, y0, x1, y1]) => [x0, y0, x1, y0, x0, y1, x1, y1] as [number, number, number, number, number, number, number, number]) }));
            const r = await editor.run(() => engine().call("markForRedaction", info.docId, items));
            if (r) setStatus(`Marked ${r.marked} item${r.marked === 1 ? "" : "s"} for redaction. Review them, then apply.`);
          }}
        />
      )}
      {dialog?.kind === "applyRedactions" && (
        <ApplyRedactionsDialog
          count={redactCount}
          signed={!!sigs?.length}
          onClose={() => setDialog(null)}
          onApply={async (o) => {
            const r = await editor.run(() => engine().call("applyRedactions", info.docId, o), { text: true });
            if (r) {
              search.clear();
              setStatus("Redactions applied. Saving will rewrite the file so the removed content is gone for good.");
            }
          }}
        />
      )}
      {dialog?.kind === "sanitize" && (
        <SanitizeDialog
          signed={!!sigs?.length}
          onClose={() => setDialog(null)}
          onApply={async (o) => {
            const r = await editor.run(() => engine().call("sanitize", info.docId, o));
            if (r) {
              const parts = Object.entries(r.report).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${{ metadata: "properties", javascript: "scripts", attachments: "attachments", comments: "comments", thumbnails: "thumbnails", privateData: "private data items" }[k]}`);
              setStatus(parts.length ? `Removed ${parts.join(", ")}. Save to finish.` : "Nothing hidden was found.");
              engine().call("attachments", info.docId).then(setAttachments, () => {});
            }
          }}
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
      {dialog?.kind === "tables" && <TablesDialog info={info} name={props.name} onClose={() => setDialog(null)} onStatus={setStatus} />}
      {dialog?.kind === "a11y" && (
        <A11yDialog
          info={info}
          name={props.name}
          run={editor.run}
          onClose={() => setDialog(null)}
          onStatus={setStatus}
          onOcr={() => {
            setDialog(null);
            setMode("protect");
            setProtectDialog({ kind: "ocr" });
          }}
        />
      )}
      {protectDialog && <ProtectDialogs dialog={protectDialog} ctx={protectCtx} onClose={() => setProtectDialog(null)} />}
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
