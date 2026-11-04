import {
  ArrowRotateClockwise20Regular,
  ArrowRotateCounterclockwise20Regular,
  BookOpen20Regular,
  ChevronDown20Regular,
  ChevronUp20Regular,
  Cursor20Regular,
  DocumentOnePage20Regular,
  DocumentMultiple20Regular,
  HandLeft20Regular,
  Info20Regular,
  MoreHorizontal20Regular,
  PanelLeft20Regular,
  Presenter20Regular,
  Print20Regular,
  ReadAloud20Regular,
  Screenshot20Regular,
  Search20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
  ZoomFit20Regular,
  ZoomIn20Regular,
  ZoomOut20Regular,
  ColorBackground20Regular,
  Eye20Regular,
} from "@fluentui/react-icons";
import { useState } from "react";
import type { DocInfo } from "../../core/types";
import { MenuButton } from "../components/Menu";
import type { LayoutMode } from "../layout";
import type { ZoomMode } from "../zoom";
import type { ReadingMode, Tool } from "./Canvas";
import { ZoomControl } from "./ZoomControl";

interface Props {
  info: DocInfo;
  currentPage: number;
  zoom: number;
  zoomMode: ZoomMode;
  layoutMode: LayoutMode;
  readingMode: ReadingMode;
  tool: Tool;
  sidebarOpen: boolean;
  searchOpen: boolean;
  speechAvailable: boolean;
  onSidebar: () => void;
  onTool: (t: Tool) => void;
  onGoPage: (i: number) => void;
  onZoomMode: (m: ZoomMode) => void;
  onZoomStep: (d: 1 | -1) => void;
  onLayout: (m: LayoutMode) => void;
  onRotate: (d: 90 | -90) => void;
  onReadingMode: (m: ReadingMode) => void;
  onSearch: () => void;
  onPresent: () => void;
  onReadAloud: () => void;
  onPrint: () => void;
  onProperties: () => void;
}

export function Toolbar(p: Props) {
  const { info, currentPage } = p;
  return (
    <div className="toolbar" role="toolbar" aria-label="Document">
      <div className="toolbar__side">
        <button className="icon-button" aria-label="Sidebar" title="Sidebar (F4)" aria-pressed={p.sidebarOpen} onClick={p.onSidebar}>
          <PanelLeft20Regular />
        </button>
        <div className="toolbar__divider" />
        <div className="segmented" role="radiogroup" aria-label="Tool">
          <button role="radio" className="icon-button" aria-label="Select text" title="Select text (V)" aria-checked={p.tool === "select"} onClick={() => p.onTool("select")}>
            <Cursor20Regular />
          </button>
          <button role="radio" className="icon-button" aria-label="Hand" title="Hand: drag to scroll (H, or hold Space)" aria-checked={p.tool === "hand"} onClick={() => p.onTool("hand")}>
            <HandLeft20Regular />
          </button>
        </div>
      </div>

      <div className="toolbar__center">
        <button className="icon-button" aria-label="Previous page" title="Previous page" disabled={currentPage === 0} onClick={() => p.onGoPage(currentPage - 1)}>
          <ChevronUp20Regular />
        </button>
        <button className="icon-button" aria-label="Next page" title="Next page" disabled={currentPage >= info.pageCount - 1} onClick={() => p.onGoPage(currentPage + 1)}>
          <ChevronDown20Regular />
        </button>
        <PageInput info={info} current={currentPage} onGo={p.onGoPage} />
        <div className="toolbar__divider" />
        <button className="icon-button" aria-label="Zoom out" title="Zoom out (Ctrl+−)" onClick={() => p.onZoomStep(-1)}>
          <ZoomOut20Regular />
        </button>
        <ZoomControl zoom={p.zoom} mode={p.zoomMode} onMode={p.onZoomMode} />
        <button className="icon-button" aria-label="Zoom in" title="Zoom in (Ctrl++)" onClick={() => p.onZoomStep(1)}>
          <ZoomIn20Regular />
        </button>
      </div>

      <div className="toolbar__side toolbar__side--end">
        <button className="icon-button" aria-label="Find" title="Find (Ctrl+F)" aria-pressed={p.searchOpen} onClick={p.onSearch}>
          <Search20Regular />
        </button>
        <MenuButton
          label="View options"
          icon={<Eye20Regular />}
          entries={() => [
            { kind: "heading", label: "Page layout" },
            { label: "Single page", icon: <DocumentOnePage20Regular />, checked: p.layoutMode === "single", onSelect: () => p.onLayout("single") },
            { label: "Two pages", icon: <DocumentMultiple20Regular />, checked: p.layoutMode === "two-page", onSelect: () => p.onLayout("two-page") },
            { label: "Two pages with cover", icon: <BookOpen20Regular />, checked: p.layoutMode === "two-page-cover", onSelect: () => p.onLayout("two-page-cover") },
            { kind: "separator" },
            { label: "Rotate clockwise", icon: <ArrowRotateClockwise20Regular />, shortcut: "Ctrl+Shift++", onSelect: () => p.onRotate(90) },
            { label: "Rotate counterclockwise", icon: <ArrowRotateCounterclockwise20Regular />, shortcut: "Ctrl+Shift+−", onSelect: () => p.onRotate(-90) },
            { kind: "separator" },
            { kind: "heading", label: "Reading mode" },
            { label: "Normal", icon: <WeatherSunny20Regular />, checked: p.readingMode === "normal", onSelect: () => p.onReadingMode("normal") },
            { label: "Night", icon: <WeatherMoon20Regular />, checked: p.readingMode === "night", onSelect: () => p.onReadingMode("night") },
            { label: "Sepia", icon: <ColorBackground20Regular />, checked: p.readingMode === "sepia", onSelect: () => p.onReadingMode("sepia") },
            { kind: "separator" },
            { label: "Snapshot (copy area as image)", icon: <Screenshot20Regular />, shortcut: "G", onSelect: () => p.onTool("snapshot") },
            { label: "Marquee zoom", icon: <ZoomFit20Regular />, shortcut: "Z", onSelect: () => p.onTool("marquee") },
            { kind: "separator" },
            { label: "Presentation", icon: <Presenter20Regular />, shortcut: "Ctrl+L", onSelect: p.onPresent },
            {
              label: "Read aloud",
              icon: <ReadAloud20Regular />,
              shortcut: "Ctrl+Shift+Y",
              disabled: !p.speechAvailable,
              reason: "No text-to-speech voices are available on this computer.",
              onSelect: p.onReadAloud,
            },
          ]}
        />
        <MenuButton
          label="More"
          icon={<MoreHorizontal20Regular />}
          entries={() => [
            { label: "Print…", icon: <Print20Regular />, shortcut: "Ctrl+P", onSelect: p.onPrint },
            { label: "Document properties", icon: <Info20Regular />, shortcut: "Ctrl+D", onSelect: p.onProperties },
          ]}
        />
      </div>
    </div>
  );
}

function PageInput({ info, current, onGo }: { info: DocInfo; current: number; onGo: (i: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const label = info.labels?.[current] ?? String(current + 1);
  const go = (value: string) => {
    const v = value.trim();
    const byLabel = info.labels?.findIndex((l) => l.toLowerCase() === v.toLowerCase()) ?? -1;
    if (byLabel >= 0) return onGo(byLabel);
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) onGo(Math.max(0, Math.min(info.pageCount - 1, n - 1)));
  };
  return (
    <label className="page-input">
      <input
        aria-label="Page number"
        value={draft ?? label}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft) {
            go(draft);
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{ width: `${Math.max(String(info.pageCount).length, label.length) + 1.5}ch` }}
      />
      <span className="page-input__total">{info.labels ? `(${current + 1} of ${info.pageCount})` : `of ${info.pageCount}`}</span>
    </label>
  );
}
