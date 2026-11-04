import { Dismiss20Regular, Send20Regular, Settings20Regular, Sparkle20Regular } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import { engine } from "../../core/client";
import type { WidgetInfo } from "../../core/forms";
import type { DocInfo, EditResult } from "../../core/types";
import { parsePageRange } from "../doc/pageRange";
import {
  destination, documentText, loadAssistant, MAX_CHARS, nextTurn, parseSuggestions, runAssistant, saveAssistant, withCitations,
  type AssistantSettings, type FieldSuggestion, type Task, type Turn,
} from "./assistant";

interface Exchange {
  /** What the person asked, as shown. */
  ask: string;
  answer: string;
  status: "streaming" | "done" | "error";
  suggestions?: FieldSuggestion[];
}

type Pending = { task: Task; ask: string; text: string; pages: number[] };

/**
 * The optional assistant, in a side panel. Off until the person turns it on; every request is shown
 * (pages, size, destination) and sent only after they confirm it.
 */
export function AssistantPanel({ info, name, currentPage, onClose, onGoPage, run }: {
  info: DocInfo;
  name: string;
  currentPage: number;
  onClose: () => void;
  onGoPage: (page: number) => void;
  run: <T extends EditResult>(op: () => Promise<T>) => Promise<T | null>;
}) {
  const [settings, setSettings] = useState<AssistantSettings>(loadAssistant);
  const [editing, setEditing] = useState(!settings.enabled);
  const [scope, setScope] = useState<"all" | "current" | "range">("all");
  const [range, setRange] = useState("");
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [history, setHistory] = useState<Turn[]>([]);
  const [fields, setFields] = useState<WidgetInfo[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = exchanges.some((e) => e.status === "streaming");

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    // Fillable fields, for "Suggest form values".
    (async () => {
      const all: WidgetInfo[] = [];
      for (let p = 0; p < info.pageCount; p++) all.push(...(await engine().call("widgets", info.docId, p)));
      setFields(all.filter((w) => ["text", "combobox", "listbox"].includes(w.type) && !w.readOnly && !w.password));
    })().catch(() => setFields([]));
  }, [info.docId, info.pageCount]);

  const pages = (): number[] | string => {
    if (scope === "current") return [currentPage];
    if (scope === "all") return Array.from({ length: info.pageCount }, (_, i) => i);
    const r = parsePageRange(range, info.pageCount);
    return typeof r === "string" ? r : r.length ? r : "Enter the pages to send, e.g. 1-5.";
  };

  const prepare = async (task: Task, ask: string) => {
    setProblem(null);
    const list = pages();
    if (typeof list === "string") return setProblem(list);
    const text = await documentText(info.docId, list);
    if (text.replace(/\[Page \d+\]|\(no text on this page\)|\s/g, "").length < 20) return setProblem("These pages have no text to send. If they're scans, recognise their text first (Protect → Recognise text).");
    if (history.length === 0 && text.length > MAX_CHARS) return setProblem(`These pages have ${text.length.toLocaleString()} characters, more than the assistant takes at once (${MAX_CHARS.toLocaleString()}). Choose fewer pages.`);
    setPending({ task, ask, text, pages: list });
  };

  const send = async () => {
    if (!pending) return;
    const { task, ask, text } = pending;
    setPending(null);
    const turn = nextTurn(task, name, text, history.length > 0);
    const isChat = task.kind === "question";
    const index = exchanges.length;
    setExchanges((x) => [...x, { ask, answer: "", status: "streaming" }]);
    abort.current = new AbortController();
    const patch = (p: Partial<Exchange>) => setExchanges((x) => x.map((e, i) => (i === index ? { ...e, ...p } : e)));
    try {
      const answer = await runAssistant({
        settings, task, name, text,
        history: isChat ? history : [],
        signal: abort.current.signal,
        onText: (t) => task.kind !== "fields" && patch({ answer: t }),
      });
      if (task.kind === "fields") {
        const suggestions = parseSuggestions(answer).filter((s) => fields.some((f) => f.name === s.field));
        patch({ status: "done", answer: suggestions.length ? "" : "The document doesn't state values for the empty fields.", suggestions });
      } else patch({ status: "done", answer });
      // Follow-up questions continue the same conversation (the document isn't sent again).
      if (isChat) setHistory((h) => [...h, { role: "user", content: turn }, { role: "assistant", content: answer }]);
    } catch (e) {
      patch({ status: "error", answer: (e as Error).name === "AbortError" ? "Stopped." : e instanceof Error ? e.message : String(e) });
    }
  };

  const apply = async (s: FieldSuggestion) => {
    const w = fields.find((f) => f.name === s.field);
    if (!w) return;
    await run(() => engine().call("setFieldValue", info.docId, w.page, w.id, s.value));
    setFields((list) => list.map((f) => (f.id === w.id ? { ...f, value: s.value } : f)));
  };

  const update = (p: Partial<AssistantSettings>) => {
    const next = { ...settings, ...p };
    setSettings(next);
    saveAssistant(next);
  };

  return (
    <aside className="assistant" aria-label="Assistant">
      <header className="assistant__head">
        <Sparkle20Regular />
        <h2 className="assistant__title">Assistant</h2>
        {settings.enabled && (
          <button className="icon-button icon-button--sm" aria-label="Assistant settings" aria-pressed={editing} onClick={() => setEditing(!editing)}><Settings20Regular /></button>
        )}
        <button className="icon-button icon-button--sm" aria-label="Close assistant" onClick={onClose}><Dismiss20Regular /></button>
      </header>
      {editing ? (
        <div className="assistant__settings">
          <p>The assistant can summarise this document, answer questions with page references, and suggest values for form fields.</p>
          <p className="muted">It's off until you turn it on. Each request shows exactly which pages will be sent and where, and nothing is sent until you confirm.</p>
          <label className="check check--stack">
            <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
            <span>Turn on the assistant</span>
          </label>
          {settings.enabled && (
            <>
              <div className="row-gap">
                <label className="radio"><input type="radio" checked={settings.provider === "anthropic"} onChange={() => update({ provider: "anthropic" })} /> Claude (your API key)</label>
                <label className="radio"><input type="radio" checked={settings.provider === "local"} onChange={() => update({ provider: "local" })} /> Local model</label>
              </div>
              {settings.provider === "anthropic" ? (
                <label className="label-stack">
                  <span className="label-text">Anthropic API key</span>
                  <input className="field" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={settings.apiKey} onChange={(e) => update({ apiKey: e.target.value.trim() })} />
                  <span className="muted">Create one at console.anthropic.com. It's kept in PDForge's settings on this computer and sent only to Anthropic.</span>
                </label>
              ) : (
                <>
                  <label className="label-stack">
                    <span className="label-text">Ollama address</span>
                    <input className="field" value={settings.localUrl} onChange={(e) => update({ localUrl: e.target.value.trim() })} />
                  </label>
                  <label className="label-stack">
                    <span className="label-text">Model</span>
                    <input className="field" value={settings.localModel} onChange={(e) => update({ localModel: e.target.value.trim() })} />
                    <span className="muted">Nothing leaves this computer. Install Ollama and a model first, e.g. <code>ollama pull llama3.1</code>.</span>
                  </label>
                </>
              )}
              <button className="button button--primary" disabled={settings.provider === "anthropic" ? !settings.apiKey : !settings.localModel} onClick={() => setEditing(false)}>Done</button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="assistant__scope">
            <span className="label-text">Use</span>
            <select className="select" aria-label="Pages to use" value={scope} onChange={(e) => setScope(e.target.value as "all")} disabled={history.length > 0}>
              <option value="all">All {info.pageCount} pages</option>
              <option value="current">Page {currentPage + 1}</option>
              <option value="range">Pages…</option>
            </select>
            {scope === "range" && <input className="field field--narrow" aria-label="Page range" placeholder="1-5" value={range} onChange={(e) => setRange(e.target.value)} disabled={history.length > 0} />}
          </div>
          <div className="assistant__actions">
            <button className="button" disabled={busy || !!pending} onClick={() => void prepare({ kind: "summary" }, "Summarise this document")}>Summarise</button>
            {fields.length > 0 && <button className="button" disabled={busy || !!pending} onClick={() => void prepare({ kind: "fields", fields }, "Suggest values for the form fields")}>Suggest form values</button>}
            {history.length > 0 && <button className="link-button" disabled={busy} onClick={() => (setHistory([]), setExchanges([]))}>New conversation</button>}
          </div>
          <div className="assistant__log" aria-live="polite">
            {exchanges.map((x, i) => (
              <div key={i} className="exchange">
                <div className="exchange__ask">{x.ask}</div>
                <div className={`exchange__answer ${x.status === "error" ? "exchange__answer--error" : ""}`}>
                  {x.status === "streaming" && !x.answer && <span className="muted">Thinking…</span>}
                  {x.answer.split(/\n{2,}/).map((para, j) => (
                    <p key={j}>
                      {withCitations(para).map((part, k) =>
                        part.kind === "text" ? (
                          <span key={k}>{part.text}</span>
                        ) : (
                          <button key={k} className="cite" title={`Go to page ${part.page + 1}`} onClick={() => onGoPage(part.page)}>{part.label}</button>
                        ),
                      )}
                    </p>
                  ))}
                  {x.suggestions && x.suggestions.length > 0 && (
                    <ul className="suggestions">
                      {x.suggestions.map((s, j) => {
                        const f = fields.find((w) => w.name === s.field);
                        const applied = f?.value === s.value;
                        return (
                          <li key={j}>
                            <div><strong>{f?.label || s.field}</strong>: {s.value}</div>
                            <div className="muted">{s.reason} <button className="cite" onClick={() => onGoPage(s.page - 1)}>p. {s.page}</button></div>
                            <button className="button button--small" disabled={applied} onClick={() => void apply(s)}>{applied ? "Filled" : "Fill in"}</button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {x.status === "streaming" && <button className="link-button" onClick={() => abort.current?.abort()}>Stop</button>}
                </div>
              </div>
            ))}
            {!exchanges.length && <p className="muted">Ask about this document, or summarise it. Answers cite the pages they come from; click a citation to go there.</p>}
          </div>
          {pending && (
            <div className="assistant__confirm" role="alertdialog" aria-label="Confirm sending">
              {pending.pages.length === 0 ? (
                <p>Send your question to {destination(settings)}? The conversation so far (with the pages you sent first) goes with it.</p>
              ) : (
              <p>
                Send {pending.pages.length === info.pageCount ? `all ${info.pageCount} pages` : pending.pages.length === 1 ? `page ${pending.pages[0] + 1}` : `${pending.pages.length} pages`} of <strong>{name}</strong> ({pending.text.length.toLocaleString()} characters
                {pending.task.kind === "fields" ? `, plus ${fields.length} field names` : ""}) to {destination(settings)}?
              </p>
              )}
              <div className="row-gap">
                <button className="button" onClick={() => setPending(null)}>Cancel</button>
                <button className="button button--primary" autoFocus onClick={() => void send()}>Send</button>
              </div>
            </div>
          )}
          {problem && <p className="error-text" role="alert">{problem}</p>}
          <form
            className="assistant__ask"
            onSubmit={(e) => {
              e.preventDefault();
              const q = question.trim();
              if (!q || busy || pending) return;
              setQuestion("");
              if (history.length) {
                // Follow-ups only send the question; still confirm.
                setPending({ task: { kind: "question", question: q }, ask: q, text: "", pages: [] });
              } else void prepare({ kind: "question", question: q }, q);
            }}
          >
            <input className="field" placeholder={history.length ? "Ask a follow-up" : "Ask about this document"} aria-label="Question" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <button className="icon-button" type="submit" aria-label="Ask" disabled={!question.trim() || busy || !!pending}><Send20Regular /></button>
          </form>
        </>
      )}
    </aside>
  );
}
