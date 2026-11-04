import { CheckmarkCircle16Filled, ErrorCircle16Filled, Info16Filled, Warning16Filled } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import type { A11yFixes, A11yReport, A11yStatus } from "../../core/a11y";
import { engine } from "../../core/client";
import { toCsv, type Table } from "../../core/tables";
import type { DocInfo, EditResult } from "../../core/types";
import { saveAs, saveFiles } from "../../platform";
import { Dialog } from "../components/Dialog";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- Tables ----

export function TablesDialog({ info, name, onClose, onStatus }: { info: DocInfo; name: string; onClose: () => void; onStatus: (s: string) => void }) {
  const [tables, setTables] = useState<Table[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [preview, setPreview] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const base = name.replace(/\.pdf$/i, "");
  useEffect(() => {
    engine().call("findTables", info.docId).then((t) => {
      setTables(t);
      setChosen(new Set(t.map((_, i) => i)));
    }, (e) => setError(errText(e)));
  }, [info.docId]);
  const label = (t: Table, i: number) => {
    const onPage = tables!.filter((x, j) => x.page === t.page && j <= i).length;
    return `Page ${t.page + 1}: table ${onPage}`;
  };
  const go = async () => {
    const list = tables!.map((t, i) => ({ t, i })).filter(({ i }) => chosen.has(i));
    try {
      let ok: unknown;
      if (format === "xlsx") {
        const bytes = await engine().call("tablesToXlsx", list.map(({ t, i }) => ({ name: label(t, i), rows: t.rows })));
        ok = await saveAs(`${base} tables.xlsx`, bytes, { name: "Excel workbook", extensions: ["xlsx"] });
      } else {
        const enc = new TextEncoder();
        const files = list.map(({ t, i }) => ({ name: `${base} ${label(t, i).replace(/[:]/g, "")}.csv`, bytes: enc.encode(toCsv(t.rows)) }));
        ok = files.length === 1 ? await saveAs(files[0].name, files[0].bytes, { name: "CSV", extensions: ["csv"] }) : await saveFiles(files);
      }
      if (ok === null) return;
      onStatus(`Exported ${list.length} table${list.length === 1 ? "" : "s"}.`);
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  };
  const t = tables?.[preview];
  return (
    <Dialog
      title="Extract tables"
      width={720}
      onClose={onClose}
      footer={
        <>
          <div className="row-gap" style={{ marginRight: "auto" }}>
            <label className="radio"><input type="radio" checked={format === "xlsx"} onChange={() => setFormat("xlsx")} /> Excel workbook (one sheet per table)</label>
            <label className="radio"><input type="radio" checked={format === "csv"} onChange={() => setFormat("csv")} /> CSV files</label>
          </div>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" disabled={!chosen.size} onClick={() => void go()}>Export…</button>
        </>
      }
    >
      {!tables && !error && <p className="muted">Looking for tables…</p>}
      {tables && !tables.length && <p>No tables found. PDForge looks for text arranged in rows and aligned columns; tables that are pictures need text recognition first.</p>}
      {tables && tables.length > 0 && (
        <div className="tables-layout">
          <ul className="tables-list" aria-label="Tables found">
            {tables.map((tb, i) => (
              <li key={i} className={preview === i ? "tables-list__item tables-list__item--on" : "tables-list__item"}>
                <input type="checkbox" aria-label={`Include ${label(tb, i)}`} checked={chosen.has(i)} onChange={(e) => { const n = new Set(chosen); if (e.target.checked) n.add(i); else n.delete(i); setChosen(n); }} />
                <button className="tables-list__name" onClick={() => setPreview(i)}>
                  {label(tb, i)}
                  <span className="muted"> · {tb.rows.length} × {tb.rows[0]?.length ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>
          {t && (
            <div className="table-preview" tabIndex={0} aria-label={`Preview of ${label(t, preview)}`}>
              <table>
                <tbody>
                  {t.rows.slice(0, 40).map((r, ri) => (
                    <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{c}</th> : <td key={ci}>{c}</td>))}</tr>
                  ))}
                </tbody>
              </table>
              {t.rows.length > 40 && <p className="muted">…and {t.rows.length - 40} more rows</p>}
            </div>
          )}
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Dialog>
  );
}

// ---- Accessibility ----

const ICON: Record<A11yStatus, JSX.Element> = {
  pass: <CheckmarkCircle16Filled className="check-status check-status--pass" />,
  fail: <ErrorCircle16Filled className="check-status check-status--fail" />,
  warn: <Warning16Filled className="check-status check-status--warn" />,
  manual: <Info16Filled className="check-status check-status--manual" />,
};
const STATUS: Record<A11yStatus, string> = { pass: "Passed", fail: "Failed", warn: "Needs review", manual: "Check by hand" };

const LANGUAGES: [string, string][] = [
  ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["de-DE", "German"], ["fr-FR", "French"], ["es-ES", "Spanish"], ["it-IT", "Italian"],
  ["pt-BR", "Portuguese (Brazil)"], ["pt-PT", "Portuguese (Portugal)"], ["nl-NL", "Dutch"], ["sv-SE", "Swedish"], ["da-DK", "Danish"], ["nb-NO", "Norwegian"],
  ["fi-FI", "Finnish"], ["pl-PL", "Polish"], ["cs-CZ", "Czech"], ["tr-TR", "Turkish"], ["el-GR", "Greek"], ["ru-RU", "Russian"], ["uk-UA", "Ukrainian"],
  ["ar", "Arabic"], ["he-IL", "Hebrew"], ["hi-IN", "Hindi"], ["bn-BD", "Bengali"], ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"], ["ja-JP", "Japanese"], ["ko-KR", "Korean"],
];

export function A11yDialog({ info, name, run, onClose, onStatus, onOcr }: {
  info: DocInfo;
  name: string;
  run: <T extends EditResult>(op: () => Promise<T>) => Promise<T | null>;
  onClose: () => void;
  onStatus: (s: string) => void;
  onOcr: () => void;
}) {
  const [report, setReport] = useState<A11yReport | null>(null);
  const [language, setLanguage] = useState("");
  const [title, setTitle] = useState("");
  const [alt, setAlt] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const r = await engine().call("checkAccessibility", info.docId, { fileName: name, lang: navigator.language || "en-US" });
      setReport(r);
      setLanguage((l) => l || r.suggested.language);
      setTitle((t) => t || r.suggested.title);
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.docId]);

  const fixable = report?.checks.filter((c) => c.fix && c.status !== "pass" && c.fix !== "ocr" && c.fix !== "altText") ?? [];
  const fixAll = async () => {
    const fixes: A11yFixes = {};
    for (const c of fixable) {
      if (c.fix === "language") fixes.language = language;
      if (c.fix === "title") fixes.title = title;
      if (c.fix === "tabOrder") fixes.tabOrder = true;
      if (c.fix === "tooltips") fixes.tooltips = true;
      if (c.fix === "linkText") fixes.linkText = true;
      if (c.fix === "bookmarks") fixes.bookmarks = true;
    }
    const altList = Object.entries(alt).filter(([, t]) => t.trim()).map(([id, text]) => ({ id: Number(id), text }));
    if (altList.length) fixes.alt = altList;
    const r = await run(() => engine().call("fixAccessibility", info.docId, fixes));
    if (r) {
      onStatus(r.done.length ? `Fixed: ${r.done.join(", ")}. Save to keep the changes.` : "Nothing to fix.");
      await load();
    }
  };
  const missingAlt = report?.figures.filter((f) => !f.alt) ?? [];
  return (
    <Dialog
      title="Accessibility"
      width={620}
      onClose={onClose}
      footer={<><button className="button" onClick={onClose}>Close</button><button className="button button--primary" disabled={!fixable.length && !Object.values(alt).some((t) => t.trim())} onClick={() => void fixAll()}>Fix what PDForge can</button></>}
    >
      {!report && !error && <p className="muted">Checking…</p>}
      {report && (
        <>
          <p>
            {report.checks.filter((c) => c.status === "fail").length
              ? `${report.checks.filter((c) => c.status === "fail").length} problem${report.checks.filter((c) => c.status === "fail").length === 1 ? "" : "s"} found${fixable.length ? `; ${fixable.length} can be fixed here` : ""}.`
              : "No problems found in the automatic checks."}
          </p>
          <ul className="check-report">
            {report.checks.map((c) => (
              <li key={c.id} className="check-report__item">
                {ICON[c.status]}
                <div style={{ flex: 1 }}>
                  <div className="check-report__label">{c.label} <span className="visually-hidden">: {STATUS[c.status]}</span></div>
                  {c.detail && <div className="muted">{c.detail}</div>}
                  {c.status !== "pass" && c.fix === "language" && (
                    <select className="select" aria-label="Document language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {!LANGUAGES.some(([v]) => v === language) && <option value={language}>{language}</option>}
                      {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  )}
                  {c.status !== "pass" && c.fix === "title" && <input className="field" aria-label="Document title" value={title} onChange={(e) => setTitle(e.target.value)} />}
                  {c.status !== "pass" && c.fix === "ocr" && <button className="link-button" onClick={onOcr}>Recognise text…</button>}
                </div>
              </li>
            ))}
          </ul>
          {missingAlt.length > 0 && (
            <fieldset className="fieldset">
              <legend className="label-text">Describe the images</legend>
              <p className="muted">Say what each image shows or why it's there. Leave decorative images empty.</p>
              {missingAlt.slice(0, 30).map((f, i) => (
                <label key={f.id} className="label-stack">
                  <span className="label-text">Image {i + 1}{f.page != null ? ` (page ${f.page + 1})` : ""}</span>
                  <input className="field" value={alt[f.id] ?? ""} onChange={(e) => setAlt({ ...alt, [f.id]: e.target.value })} />
                </label>
              ))}
            </fieldset>
          )}
          <p className="muted">These checks cover common screen-reader problems (based on PDF/UA and WCAG). Some things, like reading order and contrast, need a person to check.</p>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Dialog>
  );
}
