import { ImageAdd20Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { engine } from "../../core/client";
import type { SearchHit } from "../../core/types";
import { pickFile, type PickedFile } from "../../platform";
import { Dialog } from "../components/Dialog";
import { resolvePages, usePages, type PagesValue } from "./OrganizeDialogs";
import { parsePageRange } from "./pageRange";
import { hexToColor, PALETTE } from "./tools";

function Pages({ count, selected, value, onChange }: { count: number; selected: number[]; value: PagesValue; onChange: (v: PagesValue) => void }) {
  const err = value.kind === "range" && value.text ? parsePageRange(value.text, count) : null;
  return (
    <div className="row-gap">
      <span className="label-text">Pages</span>
      {selected.length > 0 && (
        <label className="radio"><input type="radio" checked={value.kind === "selected"} onChange={() => onChange({ ...value, kind: "selected" })} /> Current ({selected.length === 1 ? selected[0] + 1 : selected.length})</label>
      )}
      <label className="radio"><input type="radio" checked={value.kind === "all"} onChange={() => onChange({ ...value, kind: "all" })} /> All</label>
      <label className="radio radio--with-field">
        <input type="radio" checked={value.kind === "range"} onChange={() => onChange({ ...value, kind: "range" })} />
        <input className={`field field--inline ${typeof err === "string" ? "field--invalid" : ""}`} aria-label="Page range" placeholder="1-3, 5" value={value.text} onFocus={() => onChange({ ...value, kind: "range" })} onChange={(e) => onChange({ kind: "range", text: e.target.value })} />
      </label>
    </div>
  );
}

function ColorPick({ value, onChange, label = "Colour" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="row-gap" role="radiogroup" aria-label={label}>
      <span className="label-text">{label}</span>
      {[...PALETTE.map((p) => p.hex), "#7A7268"].map((c) => (
        <button key={c} role="radio" aria-checked={value.toUpperCase() === c} aria-label={c} className="swatch swatch--sm" style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

export type HeaderFooterPreset = "custom" | "numbers" | "bates";

export function HeaderFooterDialog({ preset, count, selected, fileName, onApply, onClose }: {
  preset: HeaderFooterPreset;
  count: number;
  selected: number[];
  fileName: string;
  onApply: (spec: { top: [string, string, string]; bottom: [string, string, string]; fontSize: number; color: [number, number, number]; margin: number; startNumber: number; bates?: { prefix: string; start: number; digits: number; suffix: string }; fileName: string; pages: number[] }) => void;
  onClose: () => void;
}) {
  const [top, setTop] = useState<[string, string, string]>(["", "", ""]);
  const [bottom, setBottom] = useState<[string, string, string]>(preset === "numbers" ? ["", "Page {page} of {pages}", ""] : preset === "bates" ? ["", "", "{bates}"] : ["", "", ""]);
  const [size, setSize] = useState(preset === "bates" ? 9 : 10);
  const [color, setColor] = useState("#1F1C18");
  const [margin, setMargin] = useState("0.5");
  const [start, setStart] = useState("1");
  const [bates, setBates] = useState({ prefix: "", start: "1", digits: "6", suffix: "" });
  const [pages, setPages] = useState<PagesValue>({ kind: "all", text: "" });
  const [focus, setFocus] = useState<[0 | 1, number]>([1, preset === "bates" ? 2 : 1]);
  const list = resolvePages(pages, count, selected);
  const usesBates = [...top, ...bottom].some((t) => t.includes("{bates}"));
  const set = (row: 0 | 1, i: number, v: string) => {
    const arr = [...(row ? bottom : top)] as [string, string, string];
    arr[i] = v;
    (row ? setBottom : setTop)(arr);
  };
  const insert = (token: string) => {
    const [row, i] = focus;
    set(row, i, ((row ? bottom : top)[i] + " " + token).trim());
  };
  const title = preset === "numbers" ? "Page numbers" : preset === "bates" ? "Bates numbering" : "Header and footer";
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button
            className="button button--primary"
            disabled={!list.length || ![...top, ...bottom].some((t) => t.trim())}
            onClick={() => {
              onApply({
                top, bottom, fontSize: size, color: hexToColor(color), margin: (Number(margin) || 0.5) * 72, startNumber: Number(start) || 1, fileName, pages: list,
                bates: usesBates ? { prefix: bates.prefix, start: Number(bates.start) || 1, digits: Math.max(1, Math.min(12, Number(bates.digits) || 6)), suffix: bates.suffix } : undefined,
              });
              onClose();
            }}
          >
            Apply
          </button>
        </>
      }
    >
      <div className="hf-grid">
        {(["Header", "Footer"] as const).map((label, row) => (
          <div key={label} className="hf-row">
            <span className="label-text">{label}</span>
            {["left", "centre", "right"].map((pos, i) => (
              <input
                key={pos}
                className="field"
                aria-label={`${label} ${pos}`}
                placeholder={pos}
                value={(row ? bottom : top)[i]}
                onFocus={() => setFocus([row as 0 | 1, i])}
                onChange={(e) => set(row as 0 | 1, i, e.target.value)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="row-gap">
        <span className="label-text">Insert</span>
        {[["{page}", "Page number"], ["{pages}", "Page count"], ["{date}", "Date"], ["{file}", "File name"], ["{bates}", "Bates number"]].map(([t, l]) => (
          <button key={t} className="chip" onClick={() => insert(t)}>{l}</button>
        ))}
      </div>
      {usesBates && (
        <div className="row-gap">
          <span className="label-text">Bates</span>
          <label className="label label--inline">Prefix <input className="field field--narrow" value={bates.prefix} onChange={(e) => setBates({ ...bates, prefix: e.target.value })} /></label>
          <label className="label label--inline">Start <input className="field field--narrow" inputMode="numeric" value={bates.start} onChange={(e) => setBates({ ...bates, start: e.target.value.replace(/\D/g, "") })} /></label>
          <label className="label label--inline">Digits <input className="field field--narrow" inputMode="numeric" value={bates.digits} onChange={(e) => setBates({ ...bates, digits: e.target.value.replace(/\D/g, "") })} /></label>
          <label className="label label--inline">Suffix <input className="field field--narrow" value={bates.suffix} onChange={(e) => setBates({ ...bates, suffix: e.target.value })} /></label>
        </div>
      )}
      <div className="row-gap">
        <label className="label label--inline">Size <select className="select" value={size} onChange={(e) => setSize(Number(e.target.value))}>{[7, 8, 9, 10, 11, 12, 14, 18].map((s) => <option key={s} value={s}>{s} pt</option>)}</select></label>
        <label className="label label--inline">Margin <input className="field field--narrow" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} /> in</label>
        <label className="label label--inline">First number <input className="field field--narrow" inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.replace(/\D/g, ""))} /></label>
      </div>
      <ColorPick value={color} onChange={setColor} />
      <Pages count={count} selected={selected} value={pages} onChange={setPages} />
      <p className="muted">Applying again replaces the earlier header and footer. They can be removed later from Page design.</p>
    </Dialog>
  );
}

export function WatermarkDialog({ count, selected, onApply, onClose }: {
  count: number;
  selected: number[];
  onApply: (spec: { text?: string; image?: Uint8Array; fontSize: number; color: [number, number, number]; opacity: number; rotation: number; scale: number; behind: boolean; pages: number[] }) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"text" | "image">("text");
  const [text, setText] = useState("CONFIDENTIAL");
  const [image, setImage] = useState<PickedFile | null>(null);
  const [size, setSize] = useState(64);
  const [color, setColor] = useState("#E5484D");
  const [opacity, setOpacity] = useState(0.25);
  const [rotation, setRotation] = useState(45);
  const [scale, setScale] = useState(0.5);
  const [behind, setBehind] = useState(false);
  const [pages, setPages] = usePages([]);
  const list = resolvePages(pages, count, selected);
  return (
    <Dialog
      title="Watermark"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={!list.length || (kind === "text" ? !text.trim() : !image)} onClick={() => {
            onApply({ text: kind === "text" ? text : undefined, image: kind === "image" ? image!.bytes : undefined, fontSize: size, color: hexToColor(color), opacity, rotation, scale, behind, pages: list });
            onClose();
          }}>Apply</button>
        </>
      }
    >
      <div className="segmented-tabs" role="tablist">
        <button role="tab" aria-selected={kind === "text"} className="segmented-tabs__tab" onClick={() => setKind("text")}>Text</button>
        <button role="tab" aria-selected={kind === "image"} className="segmented-tabs__tab" onClick={() => setKind("image")}>Image</button>
      </div>
      {kind === "text" ? (
        <div className="stack">
          <input className="field" aria-label="Watermark text" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row-gap">
            <label className="label label--inline">Size <select className="select" value={size} onChange={(e) => setSize(Number(e.target.value))}>{[24, 36, 48, 64, 80, 100, 140].map((s) => <option key={s} value={s}>{s} pt</option>)}</select></label>
          </div>
          <ColorPick value={color} onChange={setColor} />
        </div>
      ) : (
        <div className="file-pick">
          <button className="button" onClick={async () => setImage(await pickFile({ name: "Images", extensions: ["png", "jpg", "jpeg"] }))}><ImageAdd20Regular /> Choose image…</button>
          <span className="file-pick__name">{image?.name ?? "No image chosen"}</span>
          <label className="label label--inline">Width <select className="select" value={scale} onChange={(e) => setScale(Number(e.target.value))}>{[0.25, 0.4, 0.5, 0.75, 1].map((s) => <option key={s} value={s}>{Math.round(s * 100)}% of page</option>)}</select></label>
        </div>
      )}
      <div className="row-gap">
        <label className="label label--inline">Rotation <select className="select" value={rotation} onChange={(e) => setRotation(Number(e.target.value))}>{[0, 30, 45, 60, 90, -45].map((r) => <option key={r} value={r}>{r}°</option>)}</select></label>
        <label className="label label--inline">Opacity <select className="select" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))}>{[0.1, 0.2, 0.25, 0.35, 0.5, 0.75, 1].map((o) => <option key={o} value={o}>{Math.round(o * 100)}%</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={behind} onChange={(e) => setBehind(e.target.checked)} /> Behind page content</label>
      </div>
      <Pages count={count} selected={selected} value={pages} onChange={setPages} />
    </Dialog>
  );
}

export function BackgroundDialog({ count, selected, onApply, onClose }: { count: number; selected: number[]; onApply: (s: { color: [number, number, number]; opacity: number; pages: number[] }) => void; onClose: () => void }) {
  const [color, setColor] = useState("#FFD33D");
  const [opacity, setOpacity] = useState(0.15);
  const [pages, setPages] = usePages([]);
  const list = resolvePages(pages, count, selected);
  return (
    <Dialog title="Background" onClose={onClose} footer={<><button className="button" onClick={onClose}>Cancel</button><button className="button button--primary" disabled={!list.length} onClick={() => (onApply({ color: hexToColor(color), opacity, pages: list }), onClose())}>Apply</button></>}>
      <ColorPick value={color} onChange={setColor} />
      <div className="row-gap">
        <label className="label label--inline">Strength <select className="select" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))}>{[0.08, 0.15, 0.25, 0.5, 1].map((o) => <option key={o} value={o}>{Math.round(o * 100)}%</option>)}</select></label>
      </div>
      <Pages count={count} selected={selected} value={pages} onChange={setPages} />
    </Dialog>
  );
}

export function LinkDialogEdit({ count, onSave, onClose }: { count: number; onSave: (target: { uri: string } | { page: number }) => void; onClose: () => void }) {
  const [kind, setKind] = useState<"web" | "page">("web");
  const [uri, setUri] = useState("https://");
  const [page, setPage] = useState("1");
  const valid = kind === "web" ? /^(https?:\/\/.+|mailto:.+)/i.test(uri) : Number(page) >= 1 && Number(page) <= count;
  return (
    <Dialog title="Add link" onClose={onClose} footer={<><button className="button" onClick={onClose}>Cancel</button><button className="button button--primary" disabled={!valid} onClick={() => (onSave(kind === "web" ? { uri } : { page: Number(page) - 1 }), onClose())}>Add link</button></>}>
      <label className="radio radio--with-field"><input type="radio" checked={kind === "web"} onChange={() => setKind("web")} /> Web page or email <input className="field field--inline field--wide" aria-label="Link address" value={uri} onFocus={() => setKind("web")} onChange={(e) => setUri(e.target.value)} /></label>
      <label className="radio radio--with-field"><input type="radio" checked={kind === "page"} onChange={() => setKind("page")} /> Page in this document <input className="field field--inline field--narrow" aria-label="Target page" inputMode="numeric" value={page} onFocus={() => setKind("page")} onChange={(e) => setPage(e.target.value.replace(/\D/g, ""))} /> of {count}</label>
      {kind === "web" && !valid && uri.length > 8 && <p className="panel__error">Use a full address starting with https:// or mailto:.</p>}
    </Dialog>
  );
}

export function FindRedactDialog({ docId, onMark, onClose }: { docId: number; onMark: (hits: SearchHit[]) => void; onClose: () => void }) {
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set(["email", "phone"]));
  const [text, setText] = useState("");
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!presets.length) void engine().call("redactionPresets").then(setPresets);
  const find = async () => {
    setError(null);
    try {
      const all: SearchHit[] = [];
      for (const id of chosen) all.push(...(await engine().call("findForRedaction", docId, { preset: id })));
      if (text.trim()) all.push(...(await engine().call("findForRedaction", docId, { text, regex })));
      setHits(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Dialog
      title="Find and redact"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button" onClick={find}>Find</button>
          <button className="button button--primary" disabled={!hits?.length} onClick={() => (onMark(hits!), onClose())}>Mark {hits?.length ?? ""} for redaction</button>
        </>
      }
    >
      <fieldset className="fieldset">
        <legend>Look for</legend>
        <div className="check-columns">
          {presets.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => {
                const n = new Set(chosen);
                if (e.target.checked) n.add(p.id);
                else n.delete(p.id);
                setChosen(n);
                setHits(null);
              }} />
              {p.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="label">
        Words or phrases
        <input className="field" value={text} onChange={(e) => (setText(e.target.value), setHits(null))} placeholder="e.g. Project Bluebird" />
      </label>
      <label className="check"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Treat as a regular expression</label>
      {hits && (
        <div className="redact-results">
          <p>{hits.length ? `${hits.length} match${hits.length === 1 ? "" : "es"} found.` : "Nothing found."}</p>
          <ul>{hits.slice(0, 8).map((h, i) => <li key={i}>Page {h.page + 1}: <mark>{h.match}</mark></li>)}</ul>
          {hits.length > 8 && <p className="muted">…and {hits.length - 8} more.</p>}
        </div>
      )}
      {error && <p className="panel__error">{error}</p>}
      <p className="muted">Matches are marked first, so you can review them on the page before applying.</p>
    </Dialog>
  );
}

export function ApplyRedactionsDialog({ count, signed, onApply, onClose }: { count: number; signed: boolean; onApply: (o: { images: "pixels" | "remove" | "keep"; lineArt: boolean; blackBoxes: boolean }) => void; onClose: () => void }) {
  const [images, setImages] = useState<"pixels" | "remove" | "keep">("pixels");
  const [lineArt, setLineArt] = useState(true);
  const [boxes, setBoxes] = useState(true);
  return (
    <Dialog
      title={`Apply ${count} redaction${count === 1 ? "" : "s"}`}
      onClose={onClose}
      footer={<><button className="button" onClick={onClose}>Cancel</button><button className="button button--danger" onClick={() => (onApply({ images, lineArt, blackBoxes: boxes }), onClose())}>Apply redactions</button></>}
    >
      <p>The marked text, images and drawings will be permanently removed from the document. Once you save, they can't be recovered.</p>
      {signed && <p className="note">This document is signed. Saving after redaction rewrites the file, so existing signatures will no longer be valid.</p>}
      <fieldset className="fieldset">
        <legend>Images under a mark</legend>
        <label className="radio"><input type="radio" checked={images === "pixels"} onChange={() => setImages("pixels")} /> Remove only the covered part</label>
        <label className="radio"><input type="radio" checked={images === "remove"} onChange={() => setImages("remove")} /> Remove the whole image</label>
        <label className="radio"><input type="radio" checked={images === "keep"} onChange={() => setImages("keep")} /> Keep images</label>
      </fieldset>
      <label className="check"><input type="checkbox" checked={lineArt} onChange={(e) => setLineArt(e.target.checked)} /> Remove drawings that are fully covered</label>
      <label className="check"><input type="checkbox" checked={boxes} onChange={(e) => setBoxes(e.target.checked)} /> Fill redacted areas with black</label>
    </Dialog>
  );
}

export function SanitizeDialog({ signed, onApply, onClose }: { signed: boolean; onApply: (o: { metadata: boolean; javascript: boolean; attachments: boolean; comments: boolean; thumbnails: boolean; privateData: boolean }) => void; onClose: () => void }) {
  const [o, setO] = useState({ metadata: true, javascript: true, attachments: true, comments: false, thumbnails: true, privateData: true });
  const row = (k: keyof typeof o, label: string, hint: string) => (
    <label className="check check--stack">
      <input type="checkbox" checked={o[k]} onChange={(e) => setO({ ...o, [k]: e.target.checked })} />
      <span>
        {label}
        <span className="muted"> {hint}</span>
      </span>
    </label>
  );
  return (
    <Dialog title="Remove hidden information" onClose={onClose} footer={<><button className="button" onClick={onClose}>Cancel</button><button className="button button--danger" disabled={!Object.values(o).some(Boolean)} onClick={() => (onApply(o), onClose())}>Remove</button></>}>
      <p className="muted">Removes data you might not know is in the file before you share it.</p>
      {row("metadata", "Document properties", "author, title, application, dates")}
      {row("javascript", "Scripts and actions", "JavaScript and launch actions")}
      {row("attachments", "Attached files", "")}
      {row("comments", "Comments", "notes, highlights and drawings")}
      {row("privateData", "Private application data", "data other apps leave behind")}
      {row("thumbnails", "Embedded page thumbnails", "")}
      {signed && <p className="note">This document is signed. Saving afterwards rewrites the file, so existing signatures will no longer be valid.</p>}
      <p className="muted">Hidden layers and text drawn outside the page aren't removed yet; use redaction for content you can see.</p>
    </Dialog>
  );
}
