// The optional assistant. Off by default. It sends document text only after the person confirms
// each request, to the AI service they chose with their own key (ChatGPT, DeepSeek, Gemini, Mistral,
// Groq, OpenRouter) or to a model server on this computer (Ollama, LM Studio). All of them speak
// the OpenAI-compatible chat API. Nothing is sent in the background.
import type { WidgetInfo } from "../../core/forms";
import { engine } from "../../core/client";
import { load, save } from "../settings";

export type ProviderId = "openai" | "deepseek" | "gemini" | "mistral" | "groq" | "openrouter" | "local";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Base URL of the OpenAI-compatible API (local: editable). */
  baseUrl: string;
  /** Where to get a key; null when none is needed. */
  keyUrl: string | null;
  /** A model to start with when we know a stable name; otherwise the person picks from the list. */
  defaultModel: string;
  /** Supports response_format json_schema (otherwise json_object plus the schema in the prompt). */
  jsonSchema: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "openai", label: "ChatGPT (OpenAI)", baseUrl: "https://api.openai.com/v1", keyUrl: "platform.openai.com/api-keys", defaultModel: "", jsonSchema: true },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", keyUrl: "platform.deepseek.com/api_keys", defaultModel: "deepseek-chat", jsonSchema: false },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "aistudio.google.com/apikey", defaultModel: "", jsonSchema: false },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyUrl: "console.mistral.ai/api-keys", defaultModel: "", jsonSchema: false },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "console.groq.com/keys", defaultModel: "", jsonSchema: false },
  { id: "openrouter", label: "OpenRouter (many models)", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "openrouter.ai/keys", defaultModel: "", jsonSchema: false },
  { id: "local", label: "On this computer (Ollama, LM Studio)", baseUrl: "http://localhost:11434/v1", keyUrl: null, defaultModel: "", jsonSchema: false },
];

export const providerInfo = (id: ProviderId) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

export interface AssistantSettings {
  enabled: boolean;
  provider: ProviderId;
  /** API keys per provider (stored in PDForge's settings on this computer). */
  keys: Partial<Record<ProviderId, string>>;
  /** Chosen model per provider. */
  models: Partial<Record<ProviderId, string>>;
  /** Address of the local server (Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1). */
  localUrl: string;
}

const DEFAULTS: AssistantSettings = { enabled: false, provider: "openai", keys: {}, models: {}, localUrl: "http://localhost:11434/v1" };
const KEY = "assistant.v2";

/** Above this, the person picks a page range rather than sending everything (and nothing is cut silently). */
export const MAX_CHARS = 600_000;

export function loadAssistant(): AssistantSettings {
  // The earlier version kept an Anthropic key under "assistant"; it isn't used any more, so drop it.
  if (load<unknown>("assistant", null) !== null) save("assistant", null);
  const v = { ...DEFAULTS, ...load<Partial<AssistantSettings>>(KEY, {}) };
  if (!PROVIDERS.some((p) => p.id === v.provider)) v.provider = "openai";
  return v;
}

export function saveAssistant(s: AssistantSettings) {
  save(KEY, s);
}

export function baseUrl(s: AssistantSettings): string {
  return (s.provider === "local" ? s.localUrl : providerInfo(s.provider).baseUrl).replace(/\/+$/, "");
}

export function modelOf(s: AssistantSettings): string {
  return s.models[s.provider] || providerInfo(s.provider).defaultModel;
}

export function ready(s: AssistantSettings): boolean {
  return !!modelOf(s) && (s.provider === "local" || !!s.keys[s.provider]);
}

export function destination(s: AssistantSettings): string {
  const p = providerInfo(s.provider);
  return s.provider === "local" ? `the model "${modelOf(s)}" on this computer` : `${p.label}, model ${modelOf(s)}`;
}

/** The models the service offers to this key (OpenAI-compatible GET /models). */
export async function listModels(s: AssistantSettings, signal?: AbortSignal): Promise<string[]> {
  checkLocal(s);
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl(s)}/models`, { headers: authHeaders(s), signal });
  } catch {
    throw new Error(s.provider === "local" ? `Couldn't reach ${baseUrl(s)}. Is Ollama or LM Studio running?` : "Couldn't reach the service. Check your internet connection.");
  }
  if (resp.status === 401 || resp.status === 403) throw new Error("The service didn't accept the API key.");
  if (!resp.ok) throw new Error(`The service returned an error (${resp.status}).`);
  const body = (await resp.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => (m.id ?? "").replace(/^models\//, "")).filter(Boolean).sort();
}

function authHeaders(s: AssistantSettings): Record<string, string> {
  const key = s.keys[s.provider];
  const h: Record<string, string> = {};
  if (key) h.Authorization = `Bearer ${key}`;
  if (s.provider === "openrouter") h["X-Title"] = "PDForge";
  return h;
}

function checkLocal(s: AssistantSettings) {
  if (s.provider === "local" && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(s.localUrl.trim())) {
    throw new Error("The local address must be on this computer, like http://localhost:11434/v1.");
  }
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
  const s = o.settings;
  checkLocal(s);
  if (!ready(s)) throw new Error("Finish setting up the assistant first (service, key and model).");
  const prompt = nextTurn(o.task, o.name, o.text, !!o.history?.length);
  const info = providerInfo(s.provider);
  const body: Record<string, unknown> = {
    model: modelOf(s),
    stream: true,
    messages: [{ role: "system", content: SYSTEM }, ...(o.history ?? []), { role: "user", content: o.task.kind === "fields" && !info.jsonSchema ? `${prompt}\n\nReply with JSON only, matching this schema: ${JSON.stringify(FIELDS_SCHEMA)}` : prompt }],
  };
  if (o.task.kind === "fields") {
    body.response_format = info.jsonSchema ? { type: "json_schema", json_schema: { name: "field_suggestions", strict: true, schema: FIELDS_SCHEMA } } : { type: "json_object" };
  }
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl(s)}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(s) },
      body: JSON.stringify(body),
      signal: o.signal,
    });
  } catch {
    if (o.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    throw new Error(s.provider === "local" ? `Couldn't reach ${baseUrl(s)}. Is Ollama or LM Studio running?` : `Couldn't reach ${info.label}. Check your internet connection.`);
  }
  if (!resp.ok || !resp.body) throw new Error(await errorMessage(resp, info.label));
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let finish: string | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // Server-sent events: "data: {json}" lines, ending with "data: [DONE]".
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]; error?: { message?: string } };
          if (chunk.error) throw new Error(`${info.label}: ${chunk.error.message ?? "error"}`);
          const c = chunk.choices?.[0];
          if (c?.delta?.content) {
            text += c.delta.content;
            o.onText(text);
          }
          if (c?.finish_reason) finish = c.finish_reason;
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } catch (e) {
    if (o.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    throw e;
  }
  if (finish === "content_filter") throw new Error(`${info.label} declined this request.`);
  if (finish === "length") return `${text}\n\n(The answer was cut off at the length limit.)`;
  return text;
}

async function errorMessage(resp: Response, label: string): Promise<string> {
  let detail = "";
  try {
    const j = (await resp.json()) as { error?: { message?: string } | string };
    detail = typeof j.error === "string" ? j.error : j.error?.message ?? "";
  } catch {
    // no JSON body
  }
  if (resp.status === 401 || resp.status === 403) return `${label} didn't accept the API key. Check it in the assistant's settings.`;
  if (resp.status === 402) return `${label} says the account has no credit left.`;
  if (resp.status === 404) return `${label} doesn't know that model. Pick another in the assistant's settings.`;
  if (resp.status === 429) return `${label} is limiting requests right now (or the account's quota is used up). Try again later.`;
  return `${label} returned an error (${resp.status})${detail ? `: ${detail}` : ""}.`;
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
