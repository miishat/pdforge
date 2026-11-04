// The optional assistant. Off by default. It sends document text only after the person confirms
// each request, to either Anthropic's API (with their own key) or a local model server they run
// (Ollama's chat API). Nothing is sent in the background.
import Anthropic from "@anthropic-ai/sdk";
import { engine } from "../../core/client";
import type { WidgetInfo } from "../../core/forms";
import { load, save } from "../settings";

export type Provider = "anthropic" | "local";

export interface AssistantSettings {
  enabled: boolean;
  provider: Provider;
  /** Anthropic API key (stored in PDForge's settings on this computer). */
  apiKey: string;
  /** Local model server (Ollama), e.g. http://localhost:11434. */
  localUrl: string;
  localModel: string;
}

const DEFAULTS: AssistantSettings = { enabled: false, provider: "anthropic", apiKey: "", localUrl: "http://localhost:11434", localModel: "llama3.1" };
const KEY = "assistant";
export const CLAUDE_MODEL = "claude-opus-5-5";

/** Above this, the person picks a page range rather than sending everything (and nothing is cut silently). */
export const MAX_CHARS = 600_000;

export function loadAssistant(): AssistantSettings {
  return { ...DEFAULTS, ...load<Partial<AssistantSettings>>(KEY, {}) };
}

export function saveAssistant(s: AssistantSettings) {
  save(KEY, s);
}

export function destination(s: AssistantSettings): string {
  return s.provider === "anthropic" ? `Anthropic (Claude, ${CLAUDE_MODEL})` : `your local model "${s.localModel}" at ${s.localUrl}`;
}

/** The document's text with page markers, for the pages chosen. */
export async function documentText(docId: number, pages: number[]): Promise<string> {
  const parts: string[] = [];
  for (const p of pages) {
    const text = (await engine().call("pageText", docId, p)).trim();
    parts.push(`[Page ${p + 1}]\n${text || "(no text on this page)"}`);
  }
  return parts.join("\n\n");
}

export type Task = { kind: "summary" } | { kind: "question"; question: string } | { kind: "fields"; fields: WidgetInfo[] };

const SYSTEM = `You help someone read a PDF in PDForge. The document's text is given between <document> tags, with a [Page N] marker before each page.
Answer only from the document. When you use something from it, cite the page like [p. 3] (or [p. 3–4]) right after the sentence. If the document doesn't say, say so plainly rather than guessing.
Write in the language of the question, in short paragraphs or bullet points. No preamble.`;

function userPrompt(task: Task, name: string, text: string): string {
  const doc = `<document name="${name.replace(/"/g, "'")}">\n${text}\n</document>`;
  if (task.kind === "summary") return `${doc}\n\nSummarise this document: what it is, its main points, and any dates, amounts or actions someone needs to know about.`;
  if (task.kind === "question") return `${doc}\n\nQuestion: ${task.question}`;
  const fields = task.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, current: f.value, options: f.options.length ? f.options : undefined }));
  return `${doc}\n\nThis form has these fields:\n${JSON.stringify(fields, null, 1)}\n\nSuggest values for the empty fields that the document itself states (for example details already written elsewhere in it). Only suggest a value when the document supports it; give the page you took it from. For choice fields use one of the options exactly.`;
}

const FIELDS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: { field: { type: "string" }, value: { type: "string" }, page: { type: "integer" }, reason: { type: "string" } },
        required: ["field", "value", "page", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
};

export interface FieldSuggestion {
  field: string;
  value: string;
  page: number;
  reason: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** What goes in the next user turn: the document plus the request, or just the follow-up question. */
export function nextTurn(task: Task, name: string, text: string, followUp: boolean): string {
  return followUp && task.kind === "question" ? task.question : userPrompt(task, name, text);
}

export interface RunOptions {
  settings: AssistantSettings;
  task: Task;
  name: string;
  text: string;
  /** Earlier turns exactly as sent and received (the first one carries the document). */
  history?: Turn[];
  onText: (snapshot: string) => void;
  signal: AbortSignal;
}

/** Runs one request and returns the full answer (for fields: the suggestions as JSON text). */
export async function runAssistant(o: RunOptions): Promise<string> {
  const prompt = nextTurn(o.task, o.name, o.text, !!o.history?.length);
  return o.settings.provider === "anthropic" ? runClaude(o, prompt) : runLocal(o, prompt);
}

async function runClaude(o: RunOptions, prompt: string): Promise<string> {
  if (!o.settings.apiKey) throw new Error("Add your Anthropic API key in the assistant's settings first.");
  // A desktop app talking to the API with the person's own key; the key never leaves this computer otherwise.
  const client = new Anthropic({ apiKey: o.settings.apiKey, dangerouslyAllowBrowser: true });
  const messages: Anthropic.Beta.BetaMessageParam[] = [...(o.history ?? []).map((m) => ({ role: m.role, content: m.content })), { role: "user", content: prompt }];
  try {
    const stream = client.beta.messages.stream(
      {
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        messages,
        output_config: o.task.kind === "fields" ? { effort: "medium", format: { type: "json_schema", schema: FIELDS_SCHEMA } } : { effort: "medium" },
        // If a safety check declines a request, the API retries on a suitable fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal: o.signal },
    );
    stream.on("text", (_delta, snapshot) => o.onText(snapshot));
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new Error("Claude declined this request.");
    const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (message.stop_reason === "max_tokens") return `${text}\n\n(The answer was cut off at the length limit.)`;
    return text;
  } catch (err) {
    if (o.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Anthropic didn't accept the API key. Check it in the assistant's settings.");
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error("This API key isn't allowed to use that model.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Too many requests right now. Wait a moment and try again.");
    if (err instanceof Anthropic.BadRequestError) throw new Error(`Anthropic couldn't process the request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Anthropic. Check your internet connection.");
    if (err instanceof Anthropic.APIError) throw new Error(`Anthropic returned an error (${err.status}).`);
    throw err;
  }
}

/** Ollama's /api/chat, streamed as newline-delimited JSON. */
async function runLocal(o: RunOptions, prompt: string): Promise<string> {
  const base = o.settings.localUrl.replace(/\/+$/, "");
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("The local model address must be on this computer (http://localhost:port).");
  const messages = [{ role: "system", content: SYSTEM }, ...(o.history ?? []), { role: "user", content: prompt }];
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: o.settings.localModel, messages, stream: true, ...(o.task.kind === "fields" ? { format: FIELDS_SCHEMA } : {}) }),
      signal: o.signal,
    });
  } catch (err) {
    if (o.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    throw new Error(`Couldn't reach the local model at ${base}. Is Ollama running?`);
  }
  if (!resp.ok || !resp.body) throw new Error(`The local model returned an error (${resp.status}). Is "${o.settings.localModel}" installed?`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string };
        if (chunk.error) throw new Error(chunk.error);
        text += chunk.message?.content ?? "";
        o.onText(text);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return text;
}

export function parseSuggestions(json: string): FieldSuggestion[] {
  try {
    const v = JSON.parse(json) as { suggestions?: unknown };
    if (!Array.isArray(v.suggestions)) return [];
    return v.suggestions.filter((s): s is FieldSuggestion => !!s && typeof s === "object" && typeof (s as FieldSuggestion).field === "string" && typeof (s as FieldSuggestion).value === "string");
  } catch {
    return [];
  }
}

/** Splits an answer into text and page citations ([p. 3], [p. 3–4], [pp. 2, 5]). */
export function withCitations(text: string): ({ kind: "text"; text: string } | { kind: "cite"; label: string; page: number })[] {
  const out: ({ kind: "text"; text: string } | { kind: "cite"; label: string; page: number })[] = [];
  const re = /\[(?:p|pp|page|pages)\.?\s*(\d+)(?:\s*[–-]\s*\d+)?(?:\s*,\s*\d+)*\]/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "cite", label: m[0].slice(1, -1), page: Number(m[1]) - 1 });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
