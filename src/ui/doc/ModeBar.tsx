import {
  ArrowRedo20Regular, ArrowUndo20Regular, ArrowUpRight20Regular, CalendarLtr20Regular, Certificate20Regular,
  Checkmark20Regular, ChevronDown16Regular, Circle12Filled, CommentNote20Regular, Cursor20Regular, Dismiss20Regular,
  Eraser20Regular, Form20Regular, HandLeft20Regular, Highlight20Regular, Line20Regular, Oval20Regular, Pen20Regular,
  Pentagon20Regular, RectangleLandscape20Regular, Ruler20Regular, Shapes20Regular, Signature20Regular, TextAdd20Regular,
  TextStrikethrough20Regular, TextT20Regular, TextUnderline20Regular, TextEffects20Regular, Add16Regular, Delete16Regular,
  Textbox20Regular, Note20Regular, DocumentAdd20Regular, ArrowRotateClockwise20Regular, ArrowRotateCounterclockwise20Regular,
  Copy20Regular, Delete20Regular, ArrowExport20Regular, ArrowSwap20Regular, SplitVertical20Regular, DocumentMultiple20Regular,
  Crop20Regular, DocumentOnePage20Regular, ZoomIn20Regular, ZoomOut20Regular, TextEditStyle20Regular, Image20Regular,
  ImageAdd20Regular, Link20Regular, TextBold20Regular, TextItalic20Regular, DocumentHeaderFooter20Regular, SelectObject20Regular,
  EyeOff20Regular,
} from "@fluentui/react-icons";
import { useState, type ReactNode } from "react";
import { Menu, MenuButton, type MenuEntry } from "../components/Menu";
import type { Tool } from "./Canvas";
import type { SavedSignature } from "./signatures";
import { PALETTE, STAMPS, type AnnotTool, type MeasureScale, type Mode, type ToolStyle } from "./tools";

interface Common {
  tool: Tool;
  onTool: (t: Tool) => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  style: ToolStyle;
  /** What the style controls apply to, for the tooltip. */
  styleTarget: string;
  showFill: boolean;
  showColor: boolean;
  showFont: boolean;
  showWidth: boolean;
  onStyle: (patch: Partial<ToolStyle>) => void;
  /** Shown when an annotation is selected. */
  onDeleteSelected: (() => void) | null;
}

export function CommentBar(p: Common & { stamp: string; onStamp: (icon: string) => void; measure: MeasureScale; onMeasureScale: () => void }) {
  const t = (id: AnnotTool, label: string, icon: ReactNode, key?: string) => (
    <ToolButton id={id} label={label} icon={icon} shortcut={key} tool={p.tool} onTool={p.onTool} />
  );
  const shapeTools: [AnnotTool, string, ReactNode][] = [
    ["rect", "Rectangle", <RectangleLandscape20Regular />],
    ["ellipse", "Ellipse", <Oval20Regular />],
    ["line", "Line", <Line20Regular />],
    ["arrow", "Arrow", <ArrowUpRight20Regular />],
    ["polygon", "Polygon", <Pentagon20Regular />],
    ["polyline", "Connected lines", <Shapes20Regular />],
  ];
  const currentShape = shapeTools.find(([id]) => id === p.tool);
  const measureTools: [AnnotTool, string][] = [["distance", "Distance"], ["perimeter", "Perimeter"], ["area", "Area"]];
  return (
    <div className="modebar" role="toolbar" aria-label="Comment tools">
      <div className="modebar__group">
        <ToolButton id="select" label="Select" icon={<Cursor20Regular />} shortcut="V" tool={p.tool} onTool={p.onTool} />
        <ToolButton id="hand" label="Hand" icon={<HandLeft20Regular />} shortcut="H" tool={p.tool} onTool={p.onTool} />
      </div>
      <Divider />
      <div className="modebar__group">
        {t("highlight", "Highlight text", <Highlight20Regular />)}
        {t("underline", "Underline text", <TextUnderline20Regular />)}
        {t("strikeout", "Strike through text", <TextStrikethrough20Regular />)}
        {t("squiggly", "Squiggly underline", <TextEffects20Regular />)}
      </div>
      <Divider />
      <div className="modebar__group">
        {t("note", "Sticky note", <CommentNote20Regular />)}
        {t("text", "Text box", <TextT20Regular />)}
        {t("callout", "Callout", <Textbox20Regular />)}
      </div>
      <Divider />
      <div className="modebar__group">
        <SplitTool
          label={currentShape ? currentShape[1] : "Shapes"}
          icon={currentShape ? currentShape[2] : <Shapes20Regular />}
          active={!!currentShape}
          onMain={() => p.onTool(currentShape ? currentShape[0] : "rect")}
          entries={shapeTools.map(([id, label, icon]) => ({ label, icon, checked: p.tool === id, onSelect: () => p.onTool(id) }))}
        />
        {t("ink", "Draw", <Pen20Regular />)}
        <SplitTool
          label={`Stamp: ${STAMPS.find((s) => s.icon === p.stamp)?.label ?? p.stamp}`}
          icon={<Note20Regular />}
          active={p.tool === "stamp"}
          onMain={() => p.onTool("stamp")}
          entries={STAMPS.map((s) => ({ label: s.label, checked: s.icon === p.stamp, onSelect: () => (p.onStamp(s.icon), p.onTool("stamp")) }))}
        />
        <SplitTool
          label={`Measure (1 in = ${p.measure.ratio} ${p.measure.unit})`}
          icon={<Ruler20Regular />}
          active={measureTools.some(([id]) => id === p.tool)}
          onMain={() => p.onTool(measureTools.find(([id]) => id === p.tool)?.[0] ?? "distance")}
          entries={[
            ...measureTools.map(([id, label]) => ({ label, checked: p.tool === id, onSelect: () => p.onTool(id) })),
            { kind: "separator" } as MenuEntry,
            { label: `Scale: 1 in = ${p.measure.ratio} ${p.measure.unit}…`, onSelect: p.onMeasureScale },
          ]}
        />
      </div>
      <Divider />
      <StyleControls {...p} />
      <span className="spacer" />
      {p.onDeleteSelected && (
        <button className="icon-button" aria-label="Delete selected comment" title="Delete (Del)" onClick={p.onDeleteSelected}>
          <Delete16Regular />
        </button>
      )}
      <UndoRedo {...p} />
    </div>
  );
}

export function FillBar(
  p: Common & {
    signatures: SavedSignature[];
    placing: string | null;
    onPlaceText: () => void;
    onPlaceDate: () => void;
    onPlaceMark: (m: "check" | "cross" | "dot") => void;
    onPlaceSignature: (s: SavedSignature) => void;
    onNewSignature: (kind: "signature" | "initials") => void;
    onRemoveSignature: (s: SavedSignature) => void;
    onCertSign: () => void;
    hasForm: boolean;
    highlightFields: boolean;
    onHighlightFields: (v: boolean) => void;
    onClearForm: () => void;
  },
) {
  const sigMenu = (kind: "signature" | "initials"): MenuEntry[] => {
    const list = p.signatures.filter((s) => s.kind === kind);
    return [
      ...list.map((s, i) => ({
        label: `${kind === "initials" ? "Initials" : "Signature"} ${list.length > 1 ? i + 1 : ""}`.trim(),
        icon: <img src={s.png} alt="" className="menu__sig" />,
        onSelect: () => p.onPlaceSignature(s),
      })),
      ...(list.length ? [{ kind: "separator" } as MenuEntry] : []),
      { label: kind === "initials" ? "Create initials…" : "Create signature…", icon: <Add16Regular />, onSelect: () => p.onNewSignature(kind) },
      ...(list.length ? list.map((s, i) => ({ label: `Remove ${kind} ${list.length > 1 ? i + 1 : ""}`.trim(), icon: <Delete16Regular />, onSelect: () => p.onRemoveSignature(s) })) : []),
    ];
  };
  const placeBtn = (key: string, label: string, icon: ReactNode, onClick: () => void) => (
    <button className="icon-button" aria-label={label} title={label} aria-pressed={p.placing === key} onClick={onClick}>
      {icon}
    </button>
  );
  return (
    <div className="modebar" role="toolbar" aria-label="Fill and sign tools">
      <div className="modebar__group">
        <ToolButton id="select" label="Select" icon={<Cursor20Regular />} shortcut="V" tool={p.tool} onTool={p.onTool} />
      </div>
      <Divider />
      <div className="modebar__group">
        {placeBtn("text", "Add text", <TextAdd20Regular />, p.onPlaceText)}
        {placeBtn("date", "Add today's date", <CalendarLtr20Regular />, p.onPlaceDate)}
        {placeBtn("check", "Add check mark", <Checkmark20Regular />, () => p.onPlaceMark("check"))}
        {placeBtn("cross", "Add cross", <Dismiss20Regular />, () => p.onPlaceMark("cross"))}
        {placeBtn("dot", "Add dot", <Circle12Filled />, () => p.onPlaceMark("dot"))}
      </div>
      <Divider />
      <div className="modebar__group">
        <MenuButton label="Add signature" icon={<Signature20Regular />} text="Sign" className="text-button" entries={() => sigMenu("signature")} />
        <MenuButton label="Add initials" icon={<Pen20Regular />} text="Initials" className="text-button" entries={() => sigMenu("initials")} />
        <button className="text-button" onClick={p.onCertSign} title="Sign with a digital ID (certificate)">
          <Certificate20Regular /> Certificate
        </button>
      </div>
      {p.hasForm && (
        <>
          <Divider />
          <div className="modebar__group">
            <button className="text-button" aria-pressed={p.highlightFields} onClick={() => p.onHighlightFields(!p.highlightFields)} title="Highlight form fields">
              <Form20Regular /> Highlight fields
            </button>
            <button className="text-button" onClick={p.onClearForm} title="Clear all form fields">
              <Eraser20Regular /> Clear form
            </button>
          </div>
        </>
      )}
      <Divider />
      <StyleControls {...p} />
      <span className="spacer" />
      {p.onDeleteSelected && (
        <button className="icon-button" aria-label="Delete selected item" title="Delete (Del)" onClick={p.onDeleteSelected}>
          <Delete16Regular />
        </button>
      )}
      <UndoRedo {...p} />
    </div>
  );
}

export function OrganizeBar(p: {
  selected: number;
  pageCount: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onInsertBlank: () => void;
  onInsertFile: () => void;
  onInsertImage: () => void;
  onRotate: (by: 90 | -90) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onExtract: () => void;
  onReplace: () => void;
  onSplit: () => void;
  onCrop: () => void;
  onPageSize: () => void;
  onCombine: () => void;
  onSelectAll: () => void;
  zoom: number;
  onZoom: (z: number) => void;
}) {
  const none = p.selected === 0;
  const why = "Select pages first";
  return (
    <div className="modebar" role="toolbar" aria-label="Organize pages">
      <MenuButton
        label="Insert pages"
        icon={<DocumentAdd20Regular />}
        text="Insert"
        className="text-button"
        entries={[
          { label: "Blank page", onSelect: p.onInsertBlank },
          { label: "Pages from a file…", onSelect: p.onInsertFile },
          { label: "Image as a page…", onSelect: p.onInsertImage },
        ]}
      />
      <Divider />
      <div className="modebar__group">
        <button className="icon-button" aria-label="Rotate left" title={none ? why : "Rotate left"} disabled={none} onClick={() => p.onRotate(-90)}><ArrowRotateCounterclockwise20Regular /></button>
        <button className="icon-button" aria-label="Rotate right" title={none ? why : "Rotate right"} disabled={none} onClick={() => p.onRotate(90)}><ArrowRotateClockwise20Regular /></button>
        <button className="icon-button" aria-label="Duplicate pages" title={none ? why : "Duplicate"} disabled={none} onClick={p.onDuplicate}><Copy20Regular /></button>
        <button className="icon-button" aria-label="Delete pages" title={none ? why : p.selected >= p.pageCount ? "Can't delete every page" : "Delete (Del)"} disabled={none || p.selected >= p.pageCount} onClick={p.onDelete}><Delete20Regular /></button>
      </div>
      <Divider />
      <div className="modebar__group">
        <button className="text-button" onClick={p.onExtract}><ArrowExport20Regular /> Extract</button>
        <button className="text-button" disabled={none} title={none ? why : undefined} onClick={p.onReplace}><ArrowSwap20Regular /> Replace</button>
        <button className="text-button" onClick={p.onSplit}><SplitVertical20Regular /> Split</button>
        <button className="text-button" onClick={p.onCombine}><DocumentMultiple20Regular /> Combine files</button>
      </div>
      <Divider />
      <div className="modebar__group">
        <button className="text-button" onClick={p.onCrop}><Crop20Regular /> Crop</button>
        <button className="text-button" onClick={p.onPageSize}><DocumentOnePage20Regular /> Page size</button>
      </div>
      <span className="spacer" />
      <span className="modebar__note">{p.selected ? `${p.selected} selected` : `${p.pageCount} pages`}</span>
      <button className="text-button" onClick={p.onSelectAll}>Select all</button>
      <label className="zoom-slider" title="Thumbnail size">
        <ZoomOut20Regular />
        <input type="range" min={110} max={320} step={10} value={p.zoom} aria-label="Thumbnail size" onChange={(e) => p.onZoom(Number(e.target.value))} />
        <ZoomIn20Regular />
      </label>
      <UndoRedo {...(p as unknown as Common)} />
    </div>
  );
}

export function EditBar(p: Common & {
  markKinds: string[];
  redactions: number;
  imageSelected: boolean;
  linkSelected: boolean;
  textStyle: { family: "sans" | "serif" | "mono"; bold: boolean; italic: boolean };
  onTextStyle: (s: Partial<{ family: "sans" | "serif" | "mono"; bold: boolean; italic: boolean }>) => void;
  onReplaceImage: () => void;
  onDeleteImage: () => void;
  onDeleteLink: () => void;
  onHeaderFooter: (preset: "custom" | "numbers" | "bates") => void;
  onWatermark: () => void;
  onBackground: () => void;
  onRemoveMarks: (kind: "headerfooter" | "watermark" | "background") => void;
  onFindRedact: () => void;
  onApplyRedactions: () => void;
  onSanitize: () => void;
}) {
  const t = (id: AnnotTool, label: string, icon: ReactNode) => <ToolButton id={id} label={label} icon={icon} tool={p.tool} onTool={p.onTool} />;
  const textTools = p.tool === "addtext";
  return (
    <div className="modebar" role="toolbar" aria-label="Edit tools">
      <div className="modebar__group">
        <ToolButton id="select" label="Select" icon={<Cursor20Regular />} shortcut="V" tool={p.tool} onTool={p.onTool} />
      </div>
      <Divider />
      <div className="modebar__group">
        {t("edittext", "Edit text", <TextEditStyle20Regular />)}
        {t("addtext", "Add text", <TextAdd20Regular />)}
        {t("editimage", "Edit images", <Image20Regular />)}
        {t("addimage", "Add image", <ImageAdd20Regular />)}
        {t("link", "Links", <Link20Regular />)}
      </div>
      {p.tool === "addtext" && (
        <>
          <Divider />
          <div className="modebar__group">
            <select className="select" aria-label="Font" value={p.textStyle.family} onChange={(e) => p.onTextStyle({ family: e.target.value as "sans" })}>
              <option value="sans">Sans serif</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
            </select>
            <button className="icon-button" aria-label="Bold" aria-pressed={p.textStyle.bold} onClick={() => p.onTextStyle({ bold: !p.textStyle.bold })}><TextBold20Regular /></button>
            <button className="icon-button" aria-label="Italic" aria-pressed={p.textStyle.italic} onClick={() => p.onTextStyle({ italic: !p.textStyle.italic })}><TextItalic20Regular /></button>
          </div>
        </>
      )}
      {p.imageSelected && (
        <>
          <Divider />
          <button className="text-button" onClick={p.onReplaceImage}>Replace image…</button>
          <button className="icon-button" aria-label="Delete image" title="Delete image (Del)" onClick={p.onDeleteImage}><Delete20Regular /></button>
        </>
      )}
      {p.linkSelected && (
        <>
          <Divider />
          <button className="icon-button" aria-label="Delete link" title="Delete link (Del)" onClick={p.onDeleteLink}><Delete20Regular /></button>
        </>
      )}
      <Divider />
      <MenuButton
        label="Page design"
        icon={<DocumentHeaderFooter20Regular />}
        text="Page design"
        className="text-button"
        entries={() => [
          { label: "Header and footer…", onSelect: () => p.onHeaderFooter("custom") },
          { label: "Page numbers…", onSelect: () => p.onHeaderFooter("numbers") },
          { label: "Bates numbering…", onSelect: () => p.onHeaderFooter("bates") },
          { label: "Watermark…", onSelect: p.onWatermark },
          { label: "Background…", onSelect: p.onBackground },
          ...(p.markKinds.length ? [{ kind: "separator" } as MenuEntry] : []),
          ...(p.markKinds.includes("headerfooter") ? [{ label: "Remove header and footer", onSelect: () => p.onRemoveMarks("headerfooter") }] : []),
          ...(p.markKinds.includes("watermark") ? [{ label: "Remove watermark", onSelect: () => p.onRemoveMarks("watermark") }] : []),
          ...(p.markKinds.includes("background") ? [{ label: "Remove background", onSelect: () => p.onRemoveMarks("background") }] : []),
        ]}
      />
      <Divider />
      <div className="modebar__group">
        {t("redacttext", "Mark text for redaction", <Highlight20Regular />)}
        {t("redactarea", "Mark area for redaction", <SelectObject20Regular />)}
        <MenuButton
          label="Redact"
          icon={<EyeOff20Regular />}
          text={p.redactions ? `Redact (${p.redactions})` : "Redact"}
          className="text-button"
          entries={() => [
            { label: "Find and redact…", onSelect: p.onFindRedact },
            { label: p.redactions ? `Apply ${p.redactions} redaction${p.redactions === 1 ? "" : "s"}…` : "Apply redactions…", disabled: !p.redactions, reason: "Mark text or areas first.", onSelect: p.onApplyRedactions },
            { kind: "separator" },
            { label: "Remove hidden information…", onSelect: p.onSanitize },
          ]}
        />
      </div>
      {textTools && (
        <>
          <Divider />
          <StyleControls {...p} />
        </>
      )}
      <span className="spacer" />
      <UndoRedo {...p} />
    </div>
  );
}

function ToolButton({ id, label, icon, shortcut, tool, onTool }: { id: Tool; label: string; icon: ReactNode; shortcut?: string; tool: Tool; onTool: (t: Tool) => void }) {
  return (
    <button
      className="icon-button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={tool === id}
      onClick={() => onTool(tool === id && id !== "select" ? "select" : id)}
    >
      {icon}
    </button>
  );
}

function SplitTool({ label, icon, active, onMain, entries }: { label: string; icon: ReactNode; active: boolean; onMain: () => void; entries: MenuEntry[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="split-tool">
      <button className="icon-button" aria-label={label} title={label} aria-pressed={active} onClick={onMain}>
        {icon}
      </button>
      <button
        className="split-tool__more"
        aria-label={`${label}: more`}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.parentElement!.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <ChevronDown16Regular />
      </button>
      {menu && <Menu label={label} at={menu} entries={entries} onClose={() => setMenu(null)} />}
    </div>
  );
}

function StyleControls(p: Common) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="modebar__group" title={`Style for ${p.styleTarget}`}>
      {p.showColor && <button
        className="color-button"
        aria-label={`Colour for ${p.styleTarget}`}
        aria-haspopup="dialog"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className="color-button__swatch" style={{ background: p.style.color }} />
        {p.showFill && <span className="color-button__fill" style={{ background: p.style.fill ?? "transparent" }} data-empty={!p.style.fill || undefined} />}
        <ChevronDown16Regular />
      </button>}
      {menu && (
        <Menu
          label="Colours"
          at={menu}
          onClose={() => setMenu(null)}
          entries={[
            { kind: "heading", label: p.showFill ? "Outline" : "Colour" },
            ...PALETTE.map((c) => ({ label: c.name, icon: <span className="menu__swatch" style={{ background: c.hex }} />, checked: p.style.color.toUpperCase() === c.hex, onSelect: () => p.onStyle({ color: c.hex }) })),
            ...(p.showFill
              ? [
                  { kind: "separator" } as MenuEntry,
                  { kind: "heading", label: "Fill" } as MenuEntry,
                  { label: "No fill", checked: !p.style.fill, onSelect: () => p.onStyle({ fill: null }) },
                  ...PALETTE.map((c) => ({ label: `${c.name} fill`, icon: <span className="menu__swatch" style={{ background: c.hex }} />, checked: p.style.fill?.toUpperCase() === c.hex, onSelect: () => p.onStyle({ fill: c.hex }) })),
                ]
              : []),
          ]}
        />
      )}
      {p.showWidth && (
        <select className="select" aria-label="Line width" title="Line width" value={p.style.width} onChange={(e) => p.onStyle({ width: Number(e.target.value) })}>
          {[0.5, 1, 2, 3, 5, 8].map((w) => (
            <option key={w} value={w}>
              {w} pt
            </option>
          ))}
        </select>
      )}
      {p.showFont && (
        <select className="select" aria-label="Font size" title="Font size" value={p.style.fontSize} onChange={(e) => p.onStyle({ fontSize: Number(e.target.value) })}>
          {[8, 9, 10, 11, 12, 14, 16, 18, 24, 32].map((s) => (
            <option key={s} value={s}>
              {s} pt
            </option>
          ))}
        </select>
      )}
      <select className="select" aria-label="Opacity" title="Opacity" value={p.style.opacity} onChange={(e) => p.onStyle({ opacity: Number(e.target.value) })}>
        {[1, 0.75, 0.5, 0.25].map((o) => (
          <option key={o} value={o}>
            {Math.round(o * 100)}%
          </option>
        ))}
      </select>
    </div>
  );
}

function UndoRedo(p: Common) {
  return (
    <div className="modebar__group">
      <button className="icon-button" aria-label="Undo" title={p.undoLabel ? `Undo ${p.undoLabel.toLowerCase()} (Ctrl+Z)` : "Undo (Ctrl+Z)"} disabled={!p.canUndo} onClick={p.onUndo}>
        <ArrowUndo20Regular />
      </button>
      <button className="icon-button" aria-label="Redo" title={p.redoLabel ? `Redo ${p.redoLabel.toLowerCase()} (Ctrl+Y)` : "Redo (Ctrl+Y)"} disabled={!p.canRedo} onClick={p.onRedo}>
        <ArrowRedo20Regular />
      </button>
    </div>
  );
}

function Divider() {
  return <div className="toolbar__divider" />;
}

export function ModeSwitch({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  const modes: [Mode, string, string][] = [
    ["read", "Read", "Ctrl+Shift+1"],
    ["comment", "Comment", "Ctrl+Shift+2"],
    ["fill", "Fill & Sign", "Ctrl+Shift+3"],
    ["organize", "Organize", "Ctrl+Shift+4"],
    ["edit", "Edit", "Ctrl+Shift+5"],
  ];
  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {modes.map(([m, label, key]) => (
        <button key={m} role="tab" aria-selected={mode === m} className="mode-switch__tab" title={`${label} (${key})`} onClick={() => onMode(m)}>
          {label}
        </button>
      ))}
    </div>
  );
}
