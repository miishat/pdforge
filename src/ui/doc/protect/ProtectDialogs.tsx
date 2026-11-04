import { CheckmarkCircle16Filled, ErrorCircle16Filled, Eye20Regular, EyeOff20Regular, Warning16Filled, Wrench16Filled } from "@fluentui/react-icons";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { engine } from "../../../core/client";
import type { RepairReport, SecurityState } from "../../../core/engine";
import type { CompressReport } from "../../../core/optimize";
import { PRESETS, type CompressOptions, type CompressPreset } from "../../../core/optimize";
import type { PdfAReport, CheckStatus } from "../../../core/pdfa";
import { ALL_PERMISSIONS, type PermissionSet } from "../../../core/protect";
import type { DocInfo, EditResult } from "../../../core/types";
import { saveAs, saveFiles } from "../../../platform";
import { Dialog } from "../../components/Dialog";
import { Pages } from "../EditDialogs";
import { resolvePages, usePages } from "../OrganizeDialogs";
import { installedLanguages, OCR_LANGUAGES, recognisePages, type OcrProgress } from "../../ocr/ocr";
import type { ExportFormat, ProtectDialog } from "./ProtectBar";

export interface ProtectContext {
  info: DocInfo;
  name: string;
  currentPage: number;
  signed: boolean;
  /** Runs an edit through the editor (refreshing pages and undo state). */
  run: <T extends EditResult>(op: () => Promise<T>, opts?: { text?: boolean }) => Promise<T | null>;
  undo: () => Promise<unknown>;
  /** Re-reads security state and unsaved-changes state. */
  refresh: () => Promise<void>;
  setStatus: (s: string) => void;
}

export function ProtectDialogs({ dialog, ctx, onClose }: { dialog: ProtectDialog; ctx: ProtectContext; onClose: () => void }) {
  switch (dialog.kind) {
    case "security":
      return <SecurityDialog ctx={ctx} onClose={onClose} />;
    case "ocr":
      return <OcrDialog ctx={ctx} onClose={onClose} />;
    case "compress":
      return <CompressDialog ctx={ctx} onClose={onClose} />;
    case "export":
      return <ExportDialog ctx={ctx} initial={dialog.format} onClose={onClose} />;
    case "pdfa":
      return <PdfADialog ctx={ctx} onClose={onClose} />;
    case "repair":
      return <RepairDialog ctx={ctx} onClose={onClose} />;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

const baseName = (name: string) => name.replace(/\.pdf$/i, "");
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- Security ----

function PasswordField({ label, value, onChange, autoFocus, invalid }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; invalid?: boolean }) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="label-stack">
      <label className="label-text" htmlFor={id}>{label}</label>
      <span className="password-field">
        <input id={id} className={`field ${invalid ? "field--invalid" : ""}`} type={shown ? "text" : "password"} value={value} autoFocus={autoFocus} autoComplete="new-password" spellCheck={false} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="icon-button icon-button--sm" aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} title={shown ? "Hide" : "Show"} onClick={() => setShown(!shown)}>
          {shown ? <EyeOff20Regular /> : <Eye20Regular />}
        </button>
      </span>
    </div>
  );
}

function SecurityDialog({ ctx, onClose }: { ctx: ProtectContext; onClose: () => void }) {
  const docId = ctx.info.docId;
  const [state, setState] = useState<SecurityState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownerTry, setOwnerTry] = useState("");
  const [needOpen, setNeedOpen] = useState(false);
  const [openPw, setOpenPw] = useState("");
  const [openPw2, setOpenPw2] = useState("");
  const [ownerPw, setOwnerPw] = useState("");
  const [ownerPw2, setOwnerPw2] = useState("");
  const [print, setPrint] = useState<"high" | "low" | "none">("high");
  const [perm, setPerm] = useState<PermissionSet>(ALL_PERMISSIONS);

  useEffect(() => {
    engine().call("security", docId).then((s) => {
      setState(s);
      if (s.encrypted) {
        setPerm(s.permissions);
        setPrint(s.permissions.print ? (s.permissions.printHigh ? "high" : "low") : "none");
        setNeedOpen(s.hasOpenPassword);
      }
    }, (e) => setError(errText(e)));
  }, [docId]);

  const done = async (s: SecurityState, message: string) => {
    setState(s);
    await ctx.refresh();
    ctx.setStatus(message);
    onClose();
  };

  const mismatch = (needOpen && openPw2 !== "" && openPw !== openPw2) || (ownerPw2 !== "" && ownerPw !== ownerPw2);
  const ready = ownerPw && ownerPw === ownerPw2 && (!needOpen || (openPw && openPw === openPw2));
  const weak = (needOpen && openPw.length > 0 && openPw.length < 8) || (ownerPw.length > 0 && ownerPw.length < 8);

  if (!state) return <Dialog title="Security" onClose={onClose}>{error ? <p className="error-text">{error}</p> : <p className="muted">Reading the file's security…</p>}</Dialog>;

  if (!state.canChange) {
    return (
      <Dialog
        title="Security"
        onClose={onClose}
        footer={<><button className="button" onClick={onClose}>Cancel</button><button className="button button--primary" disabled={!ownerTry} onClick={async () => {
          try {
            setState(await engine().call("unlockOwner", docId, ownerTry));
            setError(null);
          } catch (e) {
            setError(errText(e));
          }
        }}>Continue</button></>}
      >
        <p>This file is protected ({state.method}). To change or remove its security, enter the permissions password.</p>
        <PermissionSummary p={state.permissions} />
        <PasswordField label="Permissions password" value={ownerTry} onChange={setOwnerTry} autoFocus invalid={!!error} />
        {error && <p className="error-text" role="alert">{error}</p>}
      </Dialog>
    );
  }

  const permissions: PermissionSet = { ...perm, print: print !== "none", printHigh: print === "high" };
  const apply = async () => {
    try {
      const s = await engine().call("setSecurity", docId, { userPassword: needOpen ? openPw : "", ownerPassword: ownerPw, permissions });
      await done(s, needOpen ? "The file will need a password to open once you save it." : "The restrictions apply once you save the file.");
    } catch (e) {
      setError(errText(e));
    }
  };
  const box = (k: keyof PermissionSet, label: string) => (
    <label className="check"><input type="checkbox" checked={perm[k]} onChange={(e) => setPerm({ ...perm, [k]: e.target.checked })} /> {label}</label>
  );
  return (
    <Dialog
      title="Security"
      width={520}
      onClose={onClose}
      footer={
        <>
          {state.pending && (
            <button className="button" style={{ marginRight: "auto" }} onClick={async () => done(await engine().call("cancelSecurityChange", docId), "The security change was cancelled.")}>Keep current security</button>
          )}
          {!state.pending && state.encrypted && (
            <button className="button button--danger" style={{ marginRight: "auto" }} onClick={async () => done(await engine().call("removeSecurity", docId), "Passwords and restrictions will be removed when you save.")}>Remove security</button>
          )}
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={!ready} onClick={() => void apply()}>{state.encrypted ? "Change security" : "Protect"}</button>
        </>
      }
    >
      <p className="muted">
        {state.pending === "encrypt" ? "New security will be applied when you save. " : state.pending === "decrypt" ? "Security will be removed when you save. " : state.encrypted ? `Currently protected with ${state.method}${state.weak ? ", which is weak" : ""}. ` : ""}
        Files are encrypted with AES-256.
      </p>
      <label className="check check--stack">
        <input type="checkbox" checked={needOpen} onChange={(e) => setNeedOpen(e.target.checked)} />
        <span>Require a password to open the file</span>
      </label>
      {needOpen && (
        <div className="form-pair">
          <PasswordField label="Open password" value={openPw} onChange={setOpenPw} autoFocus />
          <PasswordField label="Repeat open password" value={openPw2} onChange={setOpenPw2} invalid={needOpen && openPw2 !== "" && openPw !== openPw2} />
        </div>
      )}
      <fieldset className="fieldset">
        <legend className="label-text">Without the permissions password, people can</legend>
        <div className="row-gap">
          <span>Print</span>
          <label className="radio"><input type="radio" checked={print === "high"} onChange={() => setPrint("high")} /> Yes</label>
          <label className="radio"><input type="radio" checked={print === "low"} onChange={() => setPrint("low")} /> Low quality only</label>
          <label className="radio"><input type="radio" checked={print === "none"} onChange={() => setPrint("none")} /> No</label>
        </div>
        <div className="check-columns">
          {box("copy", "Copy text and images")}
          {box("edit", "Change content")}
          {box("annotate", "Add comments")}
          {box("fillForms", "Fill in forms and sign")}
          {box("assemble", "Insert, delete and rotate pages")}
          {box("accessibility", "Use screen readers")}
        </div>
      </fieldset>
      <div className="form-pair">
        <PasswordField label="Permissions password" value={ownerPw} onChange={setOwnerPw} autoFocus={!needOpen} />
        <PasswordField label="Repeat permissions password" value={ownerPw2} onChange={setOwnerPw2} invalid={ownerPw2 !== "" && ownerPw !== ownerPw2} />
      </div>
      {mismatch && <p className="error-text" role="alert">The passwords don't match.</p>}
      {weak && !mismatch && <p className="muted">Passwords shorter than 8 characters are easy to guess.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="note">Keep the passwords somewhere safe: a forgotten open password can't be recovered. Restrictions are honoured by PDF apps, but they aren't a strong protection on their own.</p>
    </Dialog>
  );
}

function PermissionSummary({ p }: { p: PermissionSet }) {
  const items: [boolean, string][] = [
    [p.print, p.printHigh ? "Printing" : "Low-quality printing"],
    [p.copy, "Copying"],
    [p.edit, "Changing content"],
    [p.annotate, "Comments"],
    [p.fillForms, "Filling forms"],
    [p.assemble, "Page changes"],
  ];
  return (
    <ul className="perm-list">
      {items.map(([ok, label]) => (
        <li key={label} className={ok ? "" : "perm-list__no"}>{ok ? "Allowed" : "Not allowed"}: {label.toLowerCase()}</li>
      ))}
    </ul>
  );
}

// ---- OCR ----

function OcrDialog({ ctx, onClose }: { ctx: ProtectContext; onClose: () => void }) {
  const [pages, setPages] = usePages([ctx.currentPage]);
  const [langs, setLangs] = useState<string[]>(["eng"]);
  const [installed, setInstalled] = useState<Set<string>>(new Set(["eng"]));
  const [deskew, setDeskew] = useState(true);
  const [force, setForce] = useState(false);
  const [quality, setQuality] = useState<"standard" | "fast">("standard");
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [phase, setPhase] = useState<"setup" | "running">("setup");
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    installedLanguages().then(setInstalled, () => {});
    return () => abort.current?.abort();
  }, []);
  const list = resolvePages(pages, ctx.info.pageCount, [ctx.currentPage]);
  const toDownload = langs.filter((l) => !installed.has(l));

  const start = async () => {
    setPhase("running");
    setError(null);
    abort.current = new AbortController();
    try {
      const out = await recognisePages({ docId: ctx.info.docId, pages: list, languages: langs, deskew, force, dpi: quality === "fast" ? 200 : 300 }, setProgress, abort.current.signal);
      // The layers are in; refresh the pages' text and the undo state.
      await ctx.run(async () => ({ pages: out.recognised }), { text: true });
      const { recognised, skipped } = out;
      ctx.setStatus(
        recognised.length
          ? `Recognised text on ${recognised.length} page${recognised.length === 1 ? "" : "s"}${skipped.length ? `; skipped ${skipped.length} that already had text` : ""}. It's now searchable and selectable.`
          : "Every page already has text, so nothing was recognised. Turn on \"Recognise pages that already have text\" to do it anyway.",
      );
      onClose();
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        ctx.setStatus("Text recognition was cancelled; nothing changed.");
        onClose();
        return;
      }
      setError(errText(e));
      setPhase("setup");
    }
  };

  const pct = progress ? Math.round(((progress.done + progress.pageProgress) / Math.max(1, progress.total)) * 100) : 0;
  if (phase === "running") {
    return (
      <Dialog title="Recognise text" onClose={() => abort.current?.abort()} footer={<button className="button" onClick={() => abort.current?.abort()}>Cancel</button>}>
        <p>{progress ? `Page ${progress.page + 1} · ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : toDownload.length ? "Downloading language data…" : "Starting…"}</p>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Recognition progress">
          <div className="progress__bar" style={{ width: `${pct}%` }} />
        </div>
        <p className="muted">Recognition runs on this computer; nothing is uploaded.</p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Recognise text"
      width={520}
      onClose={onClose}
      footer={<><button className="button" onClick={onClose}>Cancel</button><button className="button button--primary" disabled={!list.length || !langs.length} onClick={() => void start()}>Recognise</button></>}
    >
      <p className="muted">Finds the words in scanned pages and adds them as invisible text, so you can search, select and copy. The pages look the same.</p>
      <Pages count={ctx.info.pageCount} selected={[ctx.currentPage]} value={pages} onChange={setPages} />
      <div className="label-stack">
        <span className="label-text">Languages in the document</span>
        <LanguagePicker value={langs} installed={installed} onChange={setLangs} />
        {toDownload.length > 0 && (
          <p className="muted">
            {toDownload.map((c) => OCR_LANGUAGES.find((l) => l.code === c)?.label).join(" and ")} will be downloaded once from jsDelivr ({toDownload.length === 1 ? "a few MB" : "a few MB each"}), then works offline.
          </p>
        )}
      </div>
      <label className="check"><input type="checkbox" checked={deskew} onChange={(e) => setDeskew(e.target.checked)} /> Straighten pages that were scanned at an angle</label>
      <label className="check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Recognise pages that already have text</label>
      <div className="row-gap">
        <span className="label-text">Quality</span>
        <label className="radio"><input type="radio" checked={quality === "standard"} onChange={() => setQuality("standard")} /> Best (300 dpi)</label>
        <label className="radio"><input type="radio" checked={quality === "fast"} onChange={() => setQuality("fast")} /> Faster (200 dpi)</label>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </Dialog>
  );
}

function LanguagePicker({ value, installed, onChange }: { value: string[]; installed: Set<string>; onChange: (v: string[]) => void }) {
  const [adding, setAdding] = useState("");
  const options = OCR_LANGUAGES.filter((l) => !value.includes(l.code));
  return (
    <div className="lang-picker">
      {value.map((code) => {
        const l = OCR_LANGUAGES.find((x) => x.code === code)!;
        return (
          <span key={code} className="chip">
            {l.label}
            {!installed.has(code) && <span className="muted"> · download</span>}
            {value.length > 1 && (
              <button className="chip__remove" aria-label={`Remove ${l.label}`} onClick={() => onChange(value.filter((c) => c !== code))}>×</button>
            )}
          </span>
        );
      })}
      <select
        className="select"
        aria-label="Add a language"
        value={adding}
        onChange={(e) => {
          if (e.target.value) onChange([...value, e.target.value]);
          setAdding("");
        }}
      >
        <option value="">Add a language…</option>
        {options.map((l) => (
          <option key={l.code} value={l.code}>{l.label}{installed.has(l.code) ? "" : " (download)"}</option>
        ))}
      </select>
    </div>
  );
}

// ---- Compress ----

function CompressDialog({ ctx, onClose }: { ctx: ProtectContext; onClose: () => void }) {
  const [preset, setPreset] = useState<CompressPreset>("ebook");
  const [custom, setCustom] = useState<CompressOptions>(PRESETS.ebook);
  const [size, setSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ before: number; after: number; report: CompressReport } | null>(null);
  useEffect(() => {
    engine().call("fileSize", ctx.info.docId).then(setSize, () => {});
  }, [ctx.info.docId]);
  const opts = preset === "custom" ? custom : PRESETS[preset];

  const run = async () => {
    setBusy(true);
    const r = await ctx.run(() => engine().call("compress", ctx.info.docId, opts));
    setBusy(false);
    if (r) setResult(r);
  };

  if (result) {
    const saved = result.before - result.after;
    const pct = Math.round((saved / Math.max(1, result.before)) * 100);
    const changed = result.report.imagesResampled + result.report.imagesRecompressed;
    return (
      <Dialog
        title="Compress"
        onClose={onClose}
        footer={<>
          <button className="button" onClick={async () => { await ctx.undo(); ctx.setStatus("Compression undone."); onClose(); }}>Undo</button>
          <button className="button button--primary" onClick={() => { ctx.setStatus(saved > 0 ? `Compressed: ${formatBytes(result.before)} → ${formatBytes(result.after)}. Save to keep it.` : "The file was already compact."); onClose(); }}>Done</button>
        </>}
      >
        <div className="size-compare" aria-label="File size">
          <div><span className="label-text">Before</span><strong>{formatBytes(result.before)}</strong></div>
          <span aria-hidden="true">→</span>
          <div><span className="label-text">After</span><strong>{formatBytes(result.after)}</strong></div>
          <span className={`size-compare__delta ${saved > 0 ? "size-compare__delta--good" : ""}`}>{saved > 0 ? `−${pct}%` : "no change"}</span>
        </div>
        <p className="muted">
          {changed
            ? `${[
                result.report.imagesResampled && `${result.report.imagesResampled} image${result.report.imagesResampled === 1 ? "" : "s"} scaled down`,
                result.report.imagesRecompressed && `${result.report.imagesRecompressed} recompressed`,
              ].filter(Boolean).join(", ")}. `
            : "No images needed changing. "}
          {result.report.fontsSubset ? "Fonts were trimmed to the characters used. " : ""}
          The file is written this way when you save.
        </p>
      </Dialog>
    );
  }
  const num = (k: "imageDpi" | "jpegQuality", label: string, min: number, max: number) => (
    <label className="label-stack">
      <span className="label-text">{label}</span>
      <input className="field field--narrow" type="number" min={min} max={max} value={custom[k]} onChange={(e) => setCustom({ ...custom, [k]: Math.max(min, Math.min(max, Number(e.target.value) || min)) })} />
    </label>
  );
  return (
    <Dialog
      title="Compress"
      width={500}
      onClose={onClose}
      footer={<><button className="button" onClick={onClose}>Cancel</button><button className="button button--primary" disabled={busy} onClick={() => void run()}>{busy ? "Compressing…" : "Compress"}</button></>}
    >
      <p className="muted">Current size: {size === null ? "…" : formatBytes(size)}</p>
      <div className="preset-list" role="radiogroup" aria-label="Preset">
        {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => (
          <label key={k} className={`preset ${preset === k ? "preset--on" : ""}`}>
            <input type="radio" name="preset" checked={preset === k} onChange={() => setPreset(k)} />
            <span className="preset__title">{PRESETS[k].label}</span>
            <span className="preset__hint">{PRESETS[k].hint}</span>
          </label>
        ))}
        <label className={`preset ${preset === "custom" ? "preset--on" : ""}`}>
          <input type="radio" name="preset" checked={preset === "custom"} onChange={() => setPreset("custom")} />
          <span className="preset__title">Custom</span>
          <span className="preset__hint">Choose the settings yourself</span>
        </label>
      </div>
      {preset === "custom" && (
        <div className="custom-compress">
          <div className="row-gap">
            {num("imageDpi", "Image resolution (dpi)", 36, 1200)}
            {num("jpegQuality", "JPEG quality (10–100)", 10, 100)}
          </div>
          <label className="check"><input type="checkbox" checked={custom.recompress} onChange={(e) => setCustom({ ...custom, recompress: e.target.checked })} /> Recompress images that are already small enough</label>
          <label className="check"><input type="checkbox" checked={custom.subsetFonts} onChange={(e) => setCustom({ ...custom, subsetFonts: e.target.checked })} /> Keep only the characters used from each font</label>
          <label className="check"><input type="checkbox" checked={custom.removeUnused} onChange={(e) => setCustom({ ...custom, removeUnused: e.target.checked })} /> Remove duplicate and unused objects</label>
          <label className="check"><input type="checkbox" checked={custom.objectStreams} onChange={(e) => setCustom({ ...custom, objectStreams: e.target.checked })} /> Pack the file's structure tightly</label>
        </div>
      )}
      {ctx.signed && <p className="note">This document is signed. Compressing rewrites it, so existing signatures will no longer be valid.</p>}
    </Dialog>
  );
}

// ---- Export ----

function ExportDialog({ ctx, initial, onClose }: { ctx: ProtectContext; initial: ExportFormat; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>(initial);
  const [pages, setPages] = usePages([]);
  const [images, setImages] = useState(true);
  const [imgFormat, setImgFormat] = useState<"png" | "jpeg" | "tiff">("png");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(85);
  const [singleTiff, setSingleTiff] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = resolvePages(pages, ctx.info.pageCount, [ctx.currentPage]);
  const all = list.length === ctx.info.pageCount;
  const base = baseName(ctx.name);
  const docId = ctx.info.docId;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const subset = all ? undefined : list;
      const enc = new TextEncoder();
      let saved: string | number | null = null;
      if (format === "docx") {
        const bytes = await engine().call("exportDocx", docId, { images, pages: subset, title: base });
        saved = await saveAs(`${base}.docx`, bytes, { name: "Word document", extensions: ["docx"] });
      } else if (format === "markdown") {
        const md = await engine().call("exportMarkdown", docId, { images, pages: subset });
        saved = await saveAs(`${base}.md`, enc.encode(md), { name: "Markdown", extensions: ["md"] });
      } else if (format === "html") {
        const html = await engine().call("exportHtml", docId, { images, pages: subset, title: base });
        saved = await saveAs(`${base}.html`, enc.encode(html), { name: "Web page", extensions: ["html"] });
      } else if (format === "text") {
        const text = await engine().call("exportText", docId, subset);
        saved = await saveAs(`${base}.txt`, enc.encode(text.replace(/\f/g, "\n\f\n")), { name: "Text", extensions: ["txt"] });
      } else {
        const out = await engine().call("exportImages", docId, { format: imgFormat, dpi, pages: list, quality, singleTiff: imgFormat === "tiff" && singleTiff });
        const ext = imgFormat === "jpeg" ? "jpg" : imgFormat;
        const pad = String(ctx.info.pageCount).length;
        const files = out.map((o) => ({ name: out.length === 1 && (imgFormat === "tiff" && singleTiff) ? `${base}.${ext}` : `${base}-${String(o.page + 1).padStart(pad, "0")}.${ext}`, bytes: o.bytes }));
        saved = files.length === 1 ? await saveAs(files[0].name, files[0].bytes, { name: "Image", extensions: [ext] }) : await saveFiles(files);
      }
      setBusy(false);
      if (saved === null) return;
      ctx.setStatus(format === "images" ? "Images exported." : "Exported.");
      onClose();
    } catch (e) {
      setBusy(false);
      setError(errText(e));
    }
  };

  const formats: [ExportFormat, string, string][] = [
    ["docx", "Word document", "Editable text with headings, lists and images"],
    ["markdown", "Markdown", "Plain text with simple formatting"],
    ["html", "Web page", "Opens in any browser"],
    ["text", "Plain text", "Just the words, in reading order"],
    ["images", "Images", "Each page as a picture"],
  ];
  return (
    <Dialog
      title="Export"
      width={520}
      onClose={onClose}
      footer={<><button className="button" onClick={onClose}>Cancel</button><button className="button button--primary" disabled={busy || !list.length} onClick={() => void go()}>{busy ? "Exporting…" : "Export…"}</button></>}
    >
      <div className="preset-list" role="radiogroup" aria-label="Format">
        {formats.map(([f, label, hint]) => (
          <label key={f} className={`preset ${format === f ? "preset--on" : ""}`}>
            <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
            <span className="preset__title">{label}</span>
            <span className="preset__hint">{hint}</span>
          </label>
        ))}
      </div>
      {(format === "docx" || format === "markdown" || format === "html") && (
        <>
          <p className="muted">Best effort: PDF pages don't store paragraphs or columns, so PDForge rebuilds them from the layout. Complex pages (tables, multiple columns) may need tidying afterwards.</p>
          <label className="check"><input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} /> Include images</label>
        </>
      )}
      {format === "images" && (
        <div className="row-gap row-gap--wrap">
          <label className="label-stack">
            <span className="label-text">Format</span>
            <select className="select" value={imgFormat} onChange={(e) => setImgFormat(e.target.value as "png")}>
              <option value="png">PNG (sharp, larger)</option>
              <option value="jpeg">JPEG (smaller)</option>
              <option value="tiff">TIFF</option>
            </select>
          </label>
          <label className="label-stack">
            <span className="label-text">Resolution</span>
            <select className="select" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
              {[72, 96, 150, 200, 300, 600].map((d) => <option key={d} value={d}>{d} dpi</option>)}
            </select>
          </label>
          {imgFormat === "jpeg" && (
            <label className="label-stack">
              <span className="label-text">Quality ({quality})</span>
              <input type="range" min={30} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
            </label>
          )}
          {imgFormat === "tiff" && list.length > 1 && (
            <label className="check"><input type="checkbox" checked={singleTiff} onChange={(e) => setSingleTiff(e.target.checked)} /> All pages in one file</label>
          )}
        </div>
      )}
      <Pages count={ctx.info.pageCount} selected={[]} value={pages} onChange={setPages} />
      {error && <p className="error-text" role="alert">{error}</p>}
    </Dialog>
  );
}

// ---- PDF/A ----

const STATUS_ICON: Record<CheckStatus, JSX.Element> = {
  pass: <CheckmarkCircle16Filled className="check-status check-status--pass" />,
  fixed: <Wrench16Filled className="check-status check-status--fixed" />,
  warn: <Warning16Filled className="check-status check-status--warn" />,
  fail: <ErrorCircle16Filled className="check-status check-status--fail" />,
};
const STATUS_LABEL: Record<CheckStatus, string> = { pass: "Passed", fixed: "Fixed", warn: "Note", fail: "Needs attention" };

function PdfADialog({ ctx, onClose }: { ctx: ProtectContext; onClose: () => void }) {
  const [report, setReport] = useState<PdfAReport | null>(null);
  const [converted, setConverted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    engine().call("checkPdfA", ctx.info.docId).then(setReport, (e) => setError(errText(e)));
  }, [ctx.info.docId]);
  const fails = report?.checks.filter((c) => c.status === "fail").length ?? 0;
  const convert = async () => {
    setBusy(true);
    const r = await ctx.run(() => engine().call("convertToPdfA", ctx.info.docId), { text: true });
    setBusy(false);
    if (r) {
      setReport(r.report);
      setConverted(true);
    }
  };
  const summary = !report
    ? "Checking…"
    : converted
      ? report.ok
        ? "Converted to PDF/A-2b. Save to keep it (Save As keeps the original)."
        : "Some requirements couldn't be met automatically; the file isn't PDF/A yet."
      : report.ok
        ? `This file meets the checked requirements${report.claims ? ` and says it is ${report.claims}` : ""}.`
        : `${fails} requirement${fails === 1 ? "" : "s"} not met${report.claims ? `, although the file says it is ${report.claims}` : ""}.`;
  return (
    <Dialog
      title="PDF/A archiving"
      width={560}
      onClose={onClose}
      footer={
        converted ? (
          <>
            <button className="button" onClick={async () => { await ctx.undo(); ctx.setStatus("PDF/A conversion undone."); onClose(); }}>Undo</button>
            <button className="button button--primary" onClick={() => { ctx.setStatus(report?.ok ? "Converted to PDF/A-2b. Save to keep it." : "PDF/A conversion is incomplete; see the report."); onClose(); }}>Done</button>
          </>
        ) : (
          <>
            <button className="button" onClick={onClose}>Close</button>
            <button className="button button--primary" disabled={!report || busy || report.checks.some((c) => c.id === "encryption" && c.status === "fail")} onClick={() => void convert()}>{busy ? "Converting…" : "Convert to PDF/A-2b"}</button>
          </>
        )
      }
    >
      <p>{summary}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {report && (
        <ul className="check-report">
          {report.checks.map((c) => (
            <li key={c.id} className="check-report__item">
              {STATUS_ICON[c.status]}
              <div>
                <div className="check-report__label">{c.label} <span className="visually-hidden">: {STATUS_LABEL[c.status]}</span></div>
                {c.detail && <div className="muted">{c.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">PDF/A-2b keeps a document readable for the long term: fonts embedded, colours defined, no scripts or external content. PDForge checks the most common requirements; it isn't a certified validator, so use veraPDF when you need official confirmation.</p>
    </Dialog>
  );
}

// ---- Repair ----

function RepairDialog({ ctx, onClose }: { ctx: ProtectContext; onClose: () => void }) {
  const [report, setReport] = useState<RepairReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    engine().call("repair", ctx.info.docId).then(async (r) => {
      setReport(r);
      await ctx.refresh();
    }, (e) => setError(errText(e)));
  }, [ctx]);
  const message = useMemo(() => {
    if (!report) return null;
    if (report.brokenPages.length) {
      const list = report.brokenPages.slice(0, 10).map((p) => p + 1).join(", ");
      return `The file's structure was rebuilt, but ${report.brokenPages.length} page${report.brokenPages.length === 1 ? "" : "s"} (${list}${report.brokenPages.length > 10 ? ", …" : ""}) still can't be drawn completely. Their remaining content is kept.`;
    }
    return report.wasRepaired
      ? `The file was damaged. PDForge rebuilt its structure and all ${report.pageCount} pages read correctly.`
      : `No damage found: all ${report.pageCount} pages read correctly.`;
  }, [report]);
  return (
    <Dialog
      title="Repair"
      onClose={onClose}
      footer={<button className="button button--primary" onClick={() => { if (report) ctx.setStatus("The file will be rewritten cleanly when you save."); onClose(); }}>Done</button>}
    >
      {!report && !error && <p className="muted">Checking every page…</p>}
      {message && <p>{message}</p>}
      {report && <p className="muted">Saving writes a fresh, tidy copy of the file{report.wasRepaired ? ", so other apps can open it too" : ""}. Use Save As to keep the original.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Dialog>
  );
}
