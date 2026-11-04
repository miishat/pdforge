import { ArrowDown16Regular, ArrowUp16Regular, Dismiss16Regular, DocumentAdd20Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { engine } from "../../core/client";
import { pickFile, pickFiles, type PickedFile } from "../../platform";
import { Dialog } from "../components/Dialog";
import { parsePageRange } from "./pageRange";

const SIZES: [string, [number, number]][] = [
  ["Letter (8.5 × 11 in)", [612, 792]],
  ["Legal (8.5 × 14 in)", [612, 1008]],
  ["Tabloid (11 × 17 in)", [792, 1224]],
  ["A3 (297 × 420 mm)", [842, 1191]],
  ["A4 (210 × 297 mm)", [595, 842]],
  ["A5 (148 × 210 mm)", [420, 595]],
];

/** Which pages an action applies to: the selection, all pages, or a typed range. */
function PagesChoice({ count, selected, value, onChange }: { count: number; selected: number[]; value: PagesValue; onChange: (v: PagesValue) => void }) {
  const err = value.kind === "range" && value.text ? (typeof parsePageRange(value.text, count) === "string" ? parsePageRange(value.text, count) : null) : null;
  return (
    <fieldset className="fieldset">
      <legend>Pages</legend>
      {selected.length > 0 && (
        <label className="radio">
          <input type="radio" checked={value.kind === "selected"} onChange={() => onChange({ kind: "selected", text: value.text })} />
          Selected ({selected.length === 1 ? `page ${selected[0] + 1}` : `${selected.length} pages`})
        </label>
      )}
      <label className="radio">
        <input type="radio" checked={value.kind === "all"} onChange={() => onChange({ kind: "all", text: value.text })} />
        All {count} pages
      </label>
      <label className="radio radio--with-field">
        <input type="radio" checked={value.kind === "range"} onChange={() => onChange({ kind: "range", text: value.text })} />
        Pages
        <input className={`field field--inline ${err ? "field--invalid" : ""}`} aria-label="Page range" placeholder="e.g. 1-3, 5" value={value.text} onFocus={() => onChange({ kind: "range", text: value.text })} onChange={(e) => onChange({ kind: "range", text: e.target.value })} />
      </label>
      {err && <p className="panel__error">{err}</p>}
    </fieldset>
  );
}

export interface PagesValue {
  kind: "selected" | "all" | "range";
  text: string;
}

export function resolvePages(v: PagesValue, count: number, selected: number[]): number[] {
  if (v.kind === "selected") return [...selected].sort((a, b) => a - b);
  if (v.kind === "all") return Array.from({ length: count }, (_, i) => i);
  const r = parsePageRange(v.text, count);
  return Array.isArray(r) ? r : [];
}

export function usePages(selected: number[]) {
  return useState<PagesValue>({ kind: selected.length ? "selected" : "all", text: "" });
}

export function InsertPagesDialog({ count, at, onInsert, onClose }: { count: number; at: number; onInsert: (file: PickedFile, pages: number[] | undefined, at: number, password?: string) => Promise<string | null>; onClose: () => void }) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [srcCount, setSrcCount] = useState(0);
  const [range, setRange] = useState("");
  const [where, setWhere] = useState<"before" | "after" | "end" | "start">(count ? "after" : "end");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = range ? parsePageRange(range, srcCount) : undefined;
  const pos = where === "start" ? 0 : where === "end" ? count : where === "before" ? at : at + 1;
  return (
    <Dialog
      title="Insert pages from a file"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button
            className="button button--primary"
            disabled={!file || typeof parsed === "string"}
            onClick={async () => {
              const err = await onInsert(file!, Array.isArray(parsed) ? parsed : undefined, pos, password || undefined);
              if (err) {
                if (/password/i.test(err)) setNeedsPassword(true);
                setError(err);
              } else onClose();
            }}
          >
            Insert
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="file-pick">
          <button
            className="button"
            onClick={async () => {
              const f = await pickFile({ name: "PDF documents", extensions: ["pdf"] });
              if (!f) return;
              setFile(f);
              setError(null);
              try {
                const r = await engine().call("open", f.bytes.slice());
                if (r.status === "ok") {
                  setSrcCount(r.info.pageCount);
                  void engine().call("close", r.info.docId);
                } else {
                  setNeedsPassword(true);
                  void engine().call("close", r.docId);
                }
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            <DocumentAdd20Regular /> Choose PDF…
          </button>
          <span className="file-pick__name">{file ? `${file.name}${srcCount ? ` · ${srcCount} pages` : ""}` : "No file chosen"}</span>
        </div>
        {needsPassword && (
          <label className="label">
            Password for this file
            <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        <label className="label">
          <span>
            Pages to insert <span className="muted">(empty = all)</span>
          </span>
          <input className={`field ${typeof parsed === "string" ? "field--invalid" : ""}`} value={range} onChange={(e) => setRange(e.target.value)} placeholder="e.g. 1-3, 5" />
        </label>
        {typeof parsed === "string" && <p className="panel__error">{parsed}</p>}
        <fieldset className="fieldset">
          <legend>Where</legend>
          {count > 0 && (
            <>
              <label className="radio"><input type="radio" checked={where === "before"} onChange={() => setWhere("before")} /> Before page {at + 1}</label>
              <label className="radio"><input type="radio" checked={where === "after"} onChange={() => setWhere("after")} /> After page {at + 1}</label>
            </>
          )}
          <label className="radio"><input type="radio" checked={where === "start"} onChange={() => setWhere("start")} /> At the beginning</label>
          <label className="radio"><input type="radio" checked={where === "end"} onChange={() => setWhere("end")} /> At the end</label>
        </fieldset>
        {error && <p className="panel__error">{error}</p>}
      </div>
    </Dialog>
  );
}

export function ExtractDialog({ count, selected, onExtract, onClose }: { count: number; selected: number[]; onExtract: (pages: number[], opts: { separate: boolean; remove: boolean; open: boolean }) => void; onClose: () => void }) {
  const [pages, setPages] = usePages(selected);
  const [separate, setSeparate] = useState(false);
  const [remove, setRemove] = useState(false);
  const [open, setOpen] = useState(true);
  const list = resolvePages(pages, count, selected);
  return (
    <Dialog
      title="Extract pages"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={!list.length || (remove && list.length === count)} onClick={() => (onExtract(list, { separate, remove, open: open && !separate }), onClose())}>
            Extract {list.length || ""} page{list.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      <PagesChoice count={count} selected={selected} value={pages} onChange={setPages} />
      <label className="check"><input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} /> Save each page as its own file</label>
      {!separate && <label className="check"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Open the extracted pages in a new tab</label>}
      <label className="check"><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> Delete the pages from this document afterwards</label>
      {remove && list.length === count && <p className="panel__error">You can't remove every page.</p>}
    </Dialog>
  );
}

export function SplitDialog({ count, hasOutline, onSplit, onClose }: { count: number; hasOutline: boolean; onSplit: (plan: { kind: "every"; n: number } | { kind: "ranges"; ranges: number[][] } | { kind: "bookmarks" }) => void; onClose: () => void }) {
  const [kind, setKind] = useState<"every" | "ranges" | "bookmarks">("every");
  const [n, setN] = useState("1");
  const [ranges, setRanges] = useState("");
  const parsedRanges = ranges
    .split(";")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => parsePageRange(r, count));
  const rangeError = parsedRanges.find((r) => typeof r === "string") as string | undefined;
  const every = Math.max(1, Math.floor(Number(n) || 0));
  const parts = kind === "every" ? Math.ceil(count / every) : kind === "ranges" ? parsedRanges.length : null;
  const ok = kind === "bookmarks" ? hasOutline : kind === "every" ? Number(n) >= 1 : parsedRanges.length > 0 && !rangeError;
  return (
    <Dialog
      title="Split document"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button
            className="button button--primary"
            disabled={!ok}
            onClick={() => {
              onSplit(kind === "every" ? { kind, n: every } : kind === "ranges" ? { kind, ranges: parsedRanges as number[][] } : { kind });
              onClose();
            }}
          >
            Split{parts ? ` into ${parts} files` : ""}
          </button>
        </>
      }
    >
      <fieldset className="fieldset">
        <legend>Split</legend>
        <label className="radio radio--with-field">
          <input type="radio" checked={kind === "every"} onChange={() => setKind("every")} /> Every
          <input className="field field--inline field--narrow" aria-label="Pages per file" inputMode="numeric" value={n} onFocus={() => setKind("every")} onChange={(e) => setN(e.target.value.replace(/\D/g, ""))} />
          page(s)
        </label>
        <label className="radio radio--with-field">
          <input type="radio" checked={kind === "ranges"} onChange={() => setKind("ranges")} /> By ranges
          <input className={`field field--inline ${rangeError ? "field--invalid" : ""}`} aria-label="Ranges" placeholder="1-3; 4-10; 11-" value={ranges} onFocus={() => setKind("ranges")} onChange={(e) => setRanges(e.target.value)} />
        </label>
        {rangeError && <p className="panel__error">{rangeError}</p>}
        <label className="radio">
          <input type="radio" checked={kind === "bookmarks"} disabled={!hasOutline} onChange={() => setKind("bookmarks")} /> At each top-level bookmark
          {!hasOutline && <span className="muted"> (this document has none)</span>}
        </label>
      </fieldset>
      <p className="muted">You'll choose a folder for the new files. The original isn't changed.</p>
    </Dialog>
  );
}

export function CropDialog({ count, selected, onCrop, onCropContent, onClose }: { count: number; selected: number[]; onCrop: (pages: number[], m: { top: number; right: number; bottom: number; left: number }) => void; onCropContent: (pages: number[]) => void; onClose: () => void }) {
  const [pages, setPages] = usePages(selected);
  const [unit, setUnit] = useState<"in" | "mm">("in");
  const [m, setM] = useState({ top: "0", right: "0", bottom: "0", left: "0" });
  const toPt = (v: string) => (Number(v.replace(",", ".")) || 0) * (unit === "in" ? 72 : 72 / 25.4);
  const list = resolvePages(pages, count, selected);
  const field = (k: keyof typeof m, label: string) => (
    <label className="label label--inline">
      {label}
      <input className="field field--narrow" inputMode="decimal" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} />
    </label>
  );
  return (
    <Dialog
      title="Crop pages"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={() => (onCropContent(list), onClose())} disabled={!list.length}>Trim to content</button>
          <span className="spacer" />
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={!list.length} onClick={() => (onCrop(list, { top: toPt(m.top), right: toPt(m.right), bottom: toPt(m.bottom), left: toPt(m.left) }), onClose())}>Crop</button>
        </>
      }
    >
      <div className="crop-grid">
        {field("top", "Top")}
        {field("left", "Left")}
        {field("right", "Right")}
        {field("bottom", "Bottom")}
        <label className="label label--inline">
          Unit
          <select className="select" value={unit} onChange={(e) => setUnit(e.target.value as "in" | "mm")}>
            <option value="in">inches</option>
            <option value="mm">mm</option>
          </select>
        </label>
      </div>
      <PagesChoice count={count} selected={selected} value={pages} onChange={setPages} />
      <p className="muted">Cropping hides the margins; nothing is deleted, so it can be undone. "Trim to content" removes empty margins automatically.</p>
    </Dialog>
  );
}

export function PageSizeDialog({ count, selected, onResize, onClose }: { count: number; selected: number[]; onResize: (pages: number[], size: [number, number], scale: boolean) => void; onClose: () => void }) {
  const [pages, setPages] = usePages(selected);
  const [size, setSize] = useState(4);
  const [landscape, setLandscape] = useState(false);
  const [scale, setScale] = useState(true);
  const list = resolvePages(pages, count, selected);
  const [w, h] = SIZES[size][1];
  return (
    <Dialog
      title="Page size"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={!list.length} onClick={() => (onResize(list, landscape ? [h, w] : [w, h], scale), onClose())}>Apply</button>
        </>
      }
    >
      <div className="stack">
        <label className="label">
          Paper size
          <select className="select select--wide" value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {SIZES.map(([label], i) => <option key={label} value={i}>{label}</option>)}
          </select>
        </label>
        <div className="row-gap">
          <label className="radio"><input type="radio" checked={!landscape} onChange={() => setLandscape(false)} /> Portrait</label>
          <label className="radio"><input type="radio" checked={landscape} onChange={() => setLandscape(true)} /> Landscape</label>
        </div>
        <label className="check"><input type="checkbox" checked={scale} onChange={(e) => setScale(e.target.checked)} /> Scale content to fit the new size</label>
        <PagesChoice count={count} selected={selected} value={pages} onChange={setPages} />
      </div>
    </Dialog>
  );
}

export function ReplaceDialog({ selected, onReplace, onClose }: { selected: number[]; onReplace: (file: PickedFile, srcPages: number[], password?: string) => Promise<string | null>; onClose: () => void }) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [start, setStart] = useState("1");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const first = Math.max(1, Number(start) || 1) - 1;
  const src = selected.map((_, i) => first + i);
  return (
    <Dialog
      title={`Replace ${selected.length === 1 ? `page ${selected[0] + 1}` : `${selected.length} pages`}`}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={!file} onClick={async () => {
            const err = await onReplace(file!, src, password || undefined);
            if (err) setError(err);
            else onClose();
          }}>Replace</button>
        </>
      }
    >
      <div className="stack">
        <div className="file-pick">
          <button className="button" onClick={async () => setFile(await pickFile({ name: "PDF documents", extensions: ["pdf"] }))}>
            <DocumentAdd20Regular /> Choose PDF…
          </button>
          <span className="file-pick__name">{file?.name ?? "No file chosen"}</span>
        </div>
        <label className="label label--inline">
          Starting at page
          <input className="field field--narrow" inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.replace(/\D/g, ""))} />
          <span className="muted">of the chosen file ({selected.length} page{selected.length === 1 ? "" : "s"} used)</span>
        </label>
        <label className="label">
          <span>Password <span className="muted">(if the file has one)</span></span>
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="panel__error">{error}</p>}
      </div>
    </Dialog>
  );
}

export function CombineDialog({ initial, onCombine, onClose }: { initial: PickedFile[]; onCombine: (files: PickedFile[], bookmarks: boolean) => Promise<string | null>; onClose: () => void }) {
  const [files, setFiles] = useState<PickedFile[]>(initial);
  const [bookmarks, setBookmarks] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= files.length) return;
    const next = [...files];
    [next[i], next[j]] = [next[j], next[i]];
    setFiles(next);
  };
  return (
    <Dialog
      title="Combine files"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={files.length < 2 || busy} onClick={async () => {
            setBusy(true);
            const err = await onCombine(files, bookmarks);
            setBusy(false);
            if (err) setError(err);
            else onClose();
          }}>
            {busy ? "Combining…" : `Combine ${files.length} files`}
          </button>
        </>
      }
    >
      <ul className="combine-list">
        {files.map((f, i) => (
          <li key={`${f.name}-${i}`}>
            <span className="combine-list__name">{f.name}</span>
            <button className="icon-button icon-button--xs" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp16Regular /></button>
            <button className="icon-button icon-button--xs" aria-label={`Move ${f.name} down`} disabled={i === files.length - 1} onClick={() => move(i, 1)}><ArrowDown16Regular /></button>
            <button className="icon-button icon-button--xs" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, k) => k !== i))}><Dismiss16Regular /></button>
          </li>
        ))}
      </ul>
      <button className="button" onClick={async () => setFiles([...files, ...(await pickFiles({ name: "PDF documents", extensions: ["pdf"] }))])}>
        <DocumentAdd20Regular /> Add files…
      </button>
      <label className="check"><input type="checkbox" checked={bookmarks} onChange={(e) => setBookmarks(e.target.checked)} /> Add a bookmark for each file</label>
      <p className="muted">The combined document opens in a new tab.</p>
      {error && <p className="panel__error">{error}</p>}
    </Dialog>
  );
}
