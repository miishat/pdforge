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
