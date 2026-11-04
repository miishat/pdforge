import { useEffect, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { DocInfo, DocProperties, Permission } from "../../core/types";
import { Dialog } from "../components/Dialog";
import { parsePageRange } from "./pageRange";
import { printPages } from "./print";
import { formatBytes } from "./Sidebar";

const PERMISSION_LABELS: Record<Permission, string> = {
  print: "Printing",
  "print-hq": "High-quality printing",
  copy: "Copying text and images",
  edit: "Changing the document",
  annotate: "Commenting",
  form: "Filling in forms",
  assemble: "Page assembly",
  accessibility: "Content access for accessibility",
};

export function PropertiesDialog({
  info,
  name,
  path,
  fileSize,
  onClose,
}: {
  info: DocInfo;
  name: string;
  path: string | null;
  fileSize: number;
  onClose: () => void;
}) {
  const [props, setProps] = useState<DocProperties | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    engine().call("properties", info.docId).then(setProps, (e) => setError(String(e?.message ?? e)));
  }, [info.docId]);

  const size = props?.firstPageSize;
  const sizeText = size
    ? `${(size.width / 72).toFixed(2)} × ${(size.height / 72).toFixed(2)} in (${Math.round((size.width / 72) * 25.4)} × ${Math.round((size.height / 72) * 25.4)} mm)`
    : "—";
  const meta = props?.metadata ?? {};

  return (
    <Dialog title="Document properties" onClose={onClose} width={560} footer={<button className="button button--primary" onClick={onClose}>Close</button>}>
      {error && <p className="panel__error">{error}</p>}
      {!props && !error && <p className="muted">Reading document…</p>}
      {props && (
        <div className="props">
          <section>
            <h3>Description</h3>
            <dl>
              <Row k="Title" v={meta.Title} />
              <Row k="Author" v={meta.Author} />
              <Row k="Subject" v={meta.Subject} />
              <Row k="Keywords" v={meta.Keywords} />
              <Row k="Created" v={meta.CreationDate} />
              <Row k="Modified" v={meta.ModDate} />
              <Row k="Application" v={meta.Creator} />
              <Row k="PDF producer" v={meta.Producer} />
            </dl>
          </section>
          <section>
            <h3>File</h3>
            <dl>
              <Row k="Name" v={name} />
              <Row k="Location" v={path ? path.replace(/[\\/][^\\/]*$/, "") : undefined} />
              <Row k="Size" v={`${formatBytes(fileSize)} (${fileSize.toLocaleString()} bytes)`} />
              <Row k="Pages" v={String(props.pageCount)} />
              <Row k="Page size" v={sizeText} />
              <Row k="Version" v={props.format ?? undefined} />
              <Row k="Language" v={props.language ?? undefined} />
              {props.repaired && <Row k="Note" v="This file was damaged; PDForge repaired it while opening." />}
            </dl>
          </section>
          <section>
            <h3>Security</h3>
            <dl>
              <Row k="Encryption" v={props.encryption && props.encryption !== "None" ? props.encryption : "None"} />
            </dl>
            <ul className="perm-list">
              {(Object.keys(PERMISSION_LABELS) as Permission[]).map((p) => (
                <li key={p} data-allowed={props.permissions[p]}>
                  <span>{PERMISSION_LABELS[p]}</span>
                  <span>{props.permissions[p] ? "Allowed" : "Not allowed"}</span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>Fonts</h3>
            {props.fonts.length ? (
              <ul className="font-list">
                {props.fonts.map((f, i) => (
                  <li key={i}>
                    <span className="font-list__name">{f.name}</span>
                    <span className="muted">
                      {f.type}
                      {f.embedded ? " · embedded" : " · not embedded"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No fonts (the pages may be images).</p>
            )}
            {props.fontsTruncated && <p className="muted">Only the first 500 pages were checked.</p>}
          </section>
        </div>
      )}
    </Dialog>
  );
}

function Row({ k, v }: { k: string; v?: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v || <span className="muted">—</span>}</dd>
    </>
  );
}

export function PrintDialog({ info, currentPage, onClose }: { info: DocInfo; currentPage: number; onClose: () => void }) {
  const [which, setWhich] = useState<"all" | "current" | "range">("all");
  const [range, setRange] = useState("");
  const [quality, setQuality] = useState<150 | 300>(150);
  const [progress, setProgress] = useState<number | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const parsed = which === "range" ? parsePageRange(range, info.pageCount) : null;
  const pages = which === "all" ? info.pages.map((_, i) => i) : which === "current" ? [currentPage] : Array.isArray(parsed) ? parsed : [];
  const error = which === "range" && range && typeof parsed === "string" ? parsed : null;
  const heavy = pages.length * (quality === 300 ? 4 : 1) > 400;

  const start = async () => {
    ctrl.current = new AbortController();
    setProgress(0);
    try {
      await printPages(info, pages, quality, setProgress, ctrl.current.signal);
    } finally {
      onClose();
    }
  };

  const cancel = () => {
    ctrl.current?.abort();
    onClose();
  };

  if (!info.permissions.print) {
    return (
      <Dialog title="Print" onClose={onClose} footer={<button className="button button--primary" onClick={onClose}>OK</button>}>
        <p>The author of this document doesn't allow printing.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Print"
      onClose={cancel}
      footer={
        <>
          <button className="button" onClick={cancel}>Cancel</button>
          <button className="button button--primary" disabled={!pages.length || progress !== null} onClick={start}>
            {progress === null ? "Continue to print" : `Preparing ${progress} of ${pages.length}…`}
          </button>
        </>
      }
    >
      <fieldset className="fieldset" disabled={progress !== null}>
        <legend>Pages</legend>
        <label className="radio">
          <input type="radio" name="pages" checked={which === "all"} onChange={() => setWhich("all")} />
          All {info.pageCount} pages
        </label>
        <label className="radio">
          <input type="radio" name="pages" checked={which === "current"} onChange={() => setWhich("current")} />
          Current page ({currentPage + 1})
        </label>
        <label className="radio radio--with-field">
          <input type="radio" name="pages" checked={which === "range"} onChange={() => setWhich("range")} />
          Pages
          <input
            className={`field field--inline ${error ? "field--invalid" : ""}`}
            aria-label="Page range"
            placeholder="e.g. 1-3, 5"
            value={range}
            onFocus={() => setWhich("range")}
            onChange={(e) => setRange(e.target.value)}
          />
        </label>
        {error && <p className="panel__error">{error}</p>}
      </fieldset>
      <fieldset className="fieldset" disabled={progress !== null}>
        <legend>Quality</legend>
        <label className="radio">
          <input type="radio" name="quality" checked={quality === 150} onChange={() => setQuality(150)} />
          Standard (150 dpi), faster
        </label>
        <label className="radio">
          <input type="radio" name="quality" checked={quality === 300} onChange={() => setQuality(300)} />
          High (300 dpi), sharper small text
        </label>
      </fieldset>
      <p className="muted">Printer, paper size, copies and scaling are chosen in the next window.</p>
      {heavy && <p className="muted">This is a large job and may take a minute to prepare.</p>}
    </Dialog>
  );
}

export function LinkDialog({ uri, onOpen, onClose }: { uri: string; onOpen: () => void; onClose: () => void }) {
  const allowed = /^(https?:|mailto:)/i.test(uri);
  return (
    <Dialog
      title={allowed ? "Open this link?" : "Link blocked"}
      onClose={onClose}
      footer={
        allowed ? (
          <>
            <button className="button" onClick={onClose}>Cancel</button>
            <button className="button button--primary" onClick={() => { onOpen(); onClose(); }} autoFocus>
              {uri.startsWith("mailto:") ? "Open in mail app" : "Open in browser"}
            </button>
          </>
        ) : (
          <button className="button button--primary" onClick={onClose}>OK</button>
        )
      }
    >
      {allowed ? (
        <p className="link-url">{uri}</p>
      ) : (
        <>
          <p>For your safety, PDForge only opens web and email links. This link points to:</p>
          <p className="link-url">{uri}</p>
        </>
      )}
    </Dialog>
  );
}

export function MeasureScaleDialog({ scale, onSave, onClose }: { scale: { ratio: number; unit: string }; onSave: (s: { ratio: number; unit: string }) => void; onClose: () => void }) {
  const [ratio, setRatio] = useState(String(scale.ratio));
  const [unit, setUnit] = useState(scale.unit);
  const n = Number(ratio.replace(",", "."));
  const valid = Number.isFinite(n) && n > 0;
  return (
    <Dialog
      title="Measurement scale"
      onClose={onClose}
      width={400}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={!valid} onClick={() => (onSave({ ratio: n, unit }), onClose())}>Set scale</button>
        </>
      }
    >
      <div className="scale-row">
        <span>1 in on the page =</span>
        <input className={`field field--inline ${valid ? "" : "field--invalid"}`} aria-label="Real-world length" value={ratio} onChange={(e) => setRatio(e.target.value)} inputMode="decimal" />
        <select className="select" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
          {["in", "ft", "yd", "mi", "mm", "cm", "m", "km"].map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
      </div>
      <p className="muted">For drawings, use the scale printed on the plan, for example 1 in = 10 ft.</p>
    </Dialog>
  );
}

export function FlattenDialog({ hasForm, onFlatten, onClose }: { hasForm: boolean; onFlatten: (what: { annotations: boolean; fields: boolean }) => void; onClose: () => void }) {
  const [annotations, setAnnotations] = useState(true);
  const [fields, setFields] = useState(hasForm);
  return (
    <Dialog
      title="Flatten document"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--danger" disabled={!annotations && !fields} onClick={() => (onFlatten({ annotations, fields }), onClose())}>Flatten</button>
        </>
      }
    >
      <p>Flattening makes comments and form entries part of the page itself. They'll look the same, but can no longer be edited, and this can't be undone.</p>
      <label className="check">
        <input type="checkbox" checked={annotations} onChange={(e) => setAnnotations(e.target.checked)} />
        Comments, drawings, stamps and signatures you placed
      </label>
      {hasForm && (
        <label className="check">
          <input type="checkbox" checked={fields} onChange={(e) => setFields(e.target.checked)} />
          Form fields
        </label>
      )}
      <p className="muted">Tip: use Save As afterwards to keep the original file unchanged.</p>
    </Dialog>
  );
}

export function UnsavedDialog({ names, onSave, onDiscard, onCancel }: { names: string[]; onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  const one = names.length === 1;
  return (
    <Dialog
      title={one ? `Save changes to ${names[0]}?` : `Save changes to ${names.length} documents?`}
      onClose={onCancel}
      footer={
        <>
          <button className="button" onClick={onCancel}>Cancel</button>
          <button className="button" onClick={onDiscard}>Don't save</button>
          <button className="button button--primary" onClick={onSave} autoFocus>{one ? "Save" : "Save all"}</button>
        </>
      }
    >
      {one ? <p>Your changes will be lost if you don't save them.</p> : (
        <>
          <p>These documents have unsaved changes:</p>
          <ul className="plain-list">{names.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </Dialog>
  );
}
