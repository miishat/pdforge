import { Add16Regular, ArrowDown16Regular, ArrowUp16Regular, Delete16Regular } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import { isDesktop, pickFileRefs, pickFolderFiles, pickOutputFolder, writeInto, type PickedFileRef } from "../../platform";
import { Dialog } from "../components/Dialog";
import { MenuButton } from "../components/Menu";
import { OCR_LANGUAGES } from "../ocr/ocr";
import { formatBytes } from "../doc/protect/ProtectDialogs";
import { loadWorkflows, needsPasswords, newStep, outputName, runSteps, saveWorkflows, STEP_LABELS, type FileResult, type Step, type StepKind, type Workflow } from "./workflow";

const ORDER: StepKind[] = ["ocr", "rotate", "compress", "watermark", "pageNumbers", "sanitize", "flatten", "pdfa", "protect"];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Saved workflows (chains of steps) run on many files, one at a time, with a result per file. */
export function BatchDialog({ onClose }: { onClose: () => void }) {
  const [workflows, setWorkflows] = useState<Workflow[]>(loadWorkflows);
  const [selected, setSelected] = useState(workflows[0]?.id ?? "");
  const [inputs, setInputs] = useState<PickedFileRef[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(false);
  const [output, setOutput] = useState<{ kind: "same" } | { kind: "folder"; path: string }>({ kind: "same" });
  const [ownerPw, setOwnerPw] = useState("");
  const [openPw, setOpenPw] = useState("");
  const [running, setRunning] = useState<{ index: number; step: string } | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
  const abort = useRef<AbortController | null>(null);
  const wf = workflows.find((w) => w.id === selected) ?? null;

  useEffect(() => saveWorkflows(workflows), [workflows]);
  useEffect(() => () => abort.current?.abort(), []);

  const update = (patch: Partial<Workflow>) => setWorkflows((list) => list.map((w) => (w.id === selected ? { ...w, ...patch } : w)));
  const setStep = (i: number, s: Step) => wf && update({ steps: wf.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, d: -1 | 1) => {
    if (!wf) return;
    const steps = [...wf.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + d, 0, s);
    update({ steps });
  };
  const addWorkflow = () => {
    const w: Workflow = { id: `wf-${Date.now().toString(36)}`, name: "New workflow", steps: [], suffix: " (processed)" };
    setWorkflows((l) => [...l, w]);
    setSelected(w.id);
  };
  const pw = wf ? needsPasswords(wf.steps) : { owner: false, open: false };
  const ready = !!wf && wf.steps.length > 0 && inputs.length > 0 && (!pw.owner || ownerPw) && (!pw.open || (openPw && openPw !== ownerPw)) && !running;

  const run = async () => {
    if (!wf) return;
    let outFolder: string | null = null;
    if (output.kind === "folder") outFolder = output.path;
    abort.current = new AbortController();
    const signal = abort.current.signal;
    const out: FileResult[] = [];
    setResults([]);
    for (let i = 0; i < inputs.length; i++) {
      if (signal.aborted) break;
      const f = inputs[i];
      setRunning({ index: i, step: "Reading" });
      try {
        const bytes = await f.read();
        const result = await runSteps(bytes, f.name, wf.steps, { userPassword: openPw, ownerPassword: ownerPw }, signal, (step) => setRunning({ index: i, step }));
        const name = outputName(f.name, wf.suffix);
        // "Same folder" on the desktop writes next to each input; never over it unless the suffix is empty.
        const folder = outFolder ?? (f.path ? f.path.replace(/[\\/][^\\/]*$/, "") : null);
        if (!wf.suffix && folder && f.path && !outFolder) throw new Error("Add a name suffix, or choose another folder, so the original isn't overwritten.");
        const written = await writeInto(folder, name, result);
        out.push({ name: f.name, ok: true, message: "Done", output: written, before: bytes.length, after: result.length });
      } catch (e) {
        if ((e as Error).name === "AbortError") break;
        out.push({ name: f.name, ok: false, message: errText(e) });
      }
      setResults([...out]);
    }
    setRunning(null);
  };

  const done = results.length > 0 && !running;
  const failed = results.filter((r) => !r.ok).length;
  return (
    <Dialog
      title="Batch actions"
      width={820}
      onClose={() => (running ? abort.current?.abort() : onClose())}
      footer={
        running ? (
          <>
            <span className="muted" style={{ marginRight: "auto" }}>File {running.index + 1} of {inputs.length} · {running.step}…</span>
            <button className="button" onClick={() => abort.current?.abort()}>Stop after this file</button>
          </>
        ) : (
          <>
            {done && <span className="muted" style={{ marginRight: "auto" }} role="status">{results.length - failed} of {results.length} file{results.length === 1 ? "" : "s"} done{failed ? `; ${failed} failed` : ""}.</span>}
            <button className="button" onClick={onClose}>Close</button>
            <button className="button button--primary" disabled={!ready} onClick={() => void run()}>Run on {inputs.length || "…"} file{inputs.length === 1 ? "" : "s"}</button>
          </>
        )
      }
    >
      <div className="batch">
        <aside className="batch__list" aria-label="Workflows">
          <ul>
            {workflows.map((w) => (
              <li key={w.id}>
                <button className={`batch__wf ${w.id === selected ? "batch__wf--on" : ""}`} onClick={() => setSelected(w.id)}>
                  {w.name || "Untitled"}
                  <span className="muted">{w.steps.length} step{w.steps.length === 1 ? "" : "s"}</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="text-button" onClick={addWorkflow}><Add16Regular /> New workflow</button>
        </aside>
        <section className="batch__editor">
          {wf ? (
            <>
              <div className="row-gap">
                <label className="label-stack" style={{ flex: 1 }}>
                  <span className="label-text">Name</span>
                  <input className="field" value={wf.name} onChange={(e) => update({ name: e.target.value })} />
                </label>
                <button className="icon-button" aria-label="Delete workflow" title="Delete workflow" onClick={() => { const rest = workflows.filter((w) => w.id !== wf.id); setWorkflows(rest); setSelected(rest[0]?.id ?? ""); }}><Delete16Regular /></button>
              </div>
              <ol className="steps" aria-label="Steps">
                {wf.steps.map((s, i) => (
                  <li key={i} className="step">
                    <span className="step__num">{i + 1}</span>
                    <div className="step__body">
                      <div className="step__title">{STEP_LABELS[s.kind]}</div>
                      <StepOptions step={s} onChange={(n) => setStep(i, n)} />
                    </div>
                    <div className="step__actions">
                      <button className="icon-button icon-button--xs" aria-label={`Move ${STEP_LABELS[s.kind]} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp16Regular /></button>
                      <button className="icon-button icon-button--xs" aria-label={`Move ${STEP_LABELS[s.kind]} down`} disabled={i === wf.steps.length - 1} onClick={() => move(i, 1)}><ArrowDown16Regular /></button>
                      <button className="icon-button icon-button--xs" aria-label={`Remove ${STEP_LABELS[s.kind]}`} onClick={() => update({ steps: wf.steps.filter((_, j) => j !== i) })}><Delete16Regular /></button>
                    </div>
                  </li>
                ))}
                {!wf.steps.length && <li className="muted">No steps yet.</li>}
              </ol>
              <MenuButton label="Add a step" text="Add a step" icon={<Add16Regular />} className="text-button" entries={() => ORDER.map((k) => ({ label: STEP_LABELS[k], onSelect: () => update({ steps: [...wf.steps, newStep(k)] }) }))} />
              <label className="label-stack">
                <span className="label-text">Add to file names</span>
                <input className="field" value={wf.suffix} placeholder="(keep names)" onChange={(e) => update({ suffix: e.target.value })} />
              </label>
            </>
          ) : (
            <p className="muted">Create a workflow to start.</p>
          )}
        </section>
        <section className="batch__run">
          <span className="label-text">Files</span>
          <div className="row-gap row-gap--wrap">
            <button className="button" onClick={async () => { const f = await pickFileRefs(["pdf"]); if (f.length) { setInputs(f); setSource(null); setResults([]); } }}>Choose files…</button>
            {isDesktop && <button className="button" onClick={async () => { const r = await pickFolderFiles(["pdf"], recursive); if (r) { setInputs(r.files); setSource(r.folder); setResults([]); } }}>Choose a folder…</button>}
            {isDesktop && <label className="check"><input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} /> Include subfolders</label>}
          </div>
          <p className="muted">{inputs.length ? `${inputs.length} PDF${inputs.length === 1 ? "" : "s"}${source ? ` in ${source}` : ""}` : "No files chosen."}</p>
          {isDesktop ? (
            <div className="row-gap row-gap--wrap">
              <span className="label-text">Save results</span>
              <label className="radio"><input type="radio" checked={output.kind === "same"} onChange={() => setOutput({ kind: "same" })} /> Next to each file</label>
              <label className="radio"><input type="radio" checked={output.kind === "folder"} onChange={async () => { const p = await pickOutputFolder(); if (p) setOutput({ kind: "folder", path: p }); }} /> {output.kind === "folder" ? output.path : "In a folder…"}</label>
            </div>
          ) : (
            <p className="muted">Results download one by one.</p>
          )}
          {pw.owner && (
            <div className="form-pair">
              <label className="label-stack"><span className="label-text">Permissions password</span><input className="field" type="password" autoComplete="new-password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} /></label>
              {pw.open && <label className="label-stack"><span className="label-text">Open password</span><input className="field" type="password" autoComplete="new-password" value={openPw} onChange={(e) => setOpenPw(e.target.value)} /></label>}
            </div>
          )}
          {pw.owner && <p className="muted">Passwords aren't saved with the workflow.</p>}
          {results.length > 0 && (
            <ul className="batch__results" aria-label="Results">
              {results.map((r, i) => (
                <li key={i} className={r.ok ? "" : "batch__failed"}>
                  <strong>{r.name}</strong> {r.ok ? `→ ${r.output?.split(/[\\/]/).pop()} (${formatBytes(r.before!)} → ${formatBytes(r.after!)})` : `: ${r.message}`}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}

function StepOptions({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  switch (step.kind) {
    case "ocr":
      return (
        <div className="row-gap row-gap--wrap">
          <select className="select" aria-label="Language" value={step.languages[0]} onChange={(e) => onChange({ ...step, languages: [e.target.value] })}>
            {OCR_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={step.deskew} onChange={(e) => onChange({ ...step, deskew: e.target.checked })} /> Straighten</label>
          <span className="muted">Pages that already have text are skipped.</span>
        </div>
      );
    case "compress":
      return (
        <select className="select" aria-label="Compression" value={step.preset} onChange={(e) => onChange({ ...step, preset: e.target.value as "ebook" })}>
          <option value="screen">Screen (smallest)</option>
          <option value="ebook">E-book (balanced)</option>
          <option value="print">Print (high quality)</option>
        </select>
      );
    case "watermark":
      return (
        <div className="row-gap row-gap--wrap">
          <input className="field" aria-label="Watermark text" value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} />
          <label className="row-gap">Opacity <input type="range" min={5} max={100} value={Math.round(step.opacity * 100)} onChange={(e) => onChange({ ...step, opacity: Number(e.target.value) / 100 })} /></label>
        </div>
      );
    case "pageNumbers":
      return <input className="field" aria-label="Page number format" value={step.format} onChange={(e) => onChange({ ...step, format: e.target.value })} title="{page} and {pages} are replaced" />;
    case "rotate":
      return (
        <select className="select" aria-label="Rotation" value={step.by} onChange={(e) => onChange({ ...step, by: Number(e.target.value) as 90 })}>
          <option value={90}>90° clockwise</option>
          <option value={-90}>90° counterclockwise</option>
          <option value={180}>180°</option>
        </select>
      );
    case "protect":
      return <label className="check"><input type="checkbox" checked={step.requireOpen} onChange={(e) => onChange({ ...step, requireOpen: e.target.checked })} /> Also require a password to open</label>;
    default:
      return null;
  }
}
