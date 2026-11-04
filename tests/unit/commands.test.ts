import { describe, expect, it } from "vitest";
import { COMMANDS, comboOf, conflicts, effectiveKeymap, matchScore, reverseKeymap } from "../../src/ui/commands";
import { parseSuggestions, withCitations } from "../../src/ui/ai/assistant";
import { needsPasswords, newStep, outputName } from "../../src/ui/batch/workflow";

const key = (over: Partial<KeyboardEvent>) => ({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

describe("shortcuts", () => {
  it("normalises key events, independent of shifted symbols", () => {
    expect(comboOf(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
    expect(comboOf(key({ key: "=", code: "Equal", ctrlKey: true }))).toBe("Ctrl+Plus");
    expect(comboOf(key({ key: "s", code: "KeyS", ctrlKey: true }))).toBe("Ctrl+S");
    expect(comboOf(key({ key: "F3", code: "F3", shiftKey: true }))).toBe("Shift+F3");
    expect(comboOf(key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }))).toBe("Alt+ArrowLeft");
    expect(comboOf(key({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeNull();
  });

  it("has no duplicate default shortcuts", () => {
    const seen = new Map<string, string>();
    for (const c of COMMANDS) for (const k of c.keys) {
      expect(seen.get(k), `${k} is used by ${seen.get(k)} and ${c.id}`).toBeUndefined();
      seen.set(k, c.id);
    }
  });

  it("applies overrides and finds conflicts", () => {
    const km = effectiveKeymap({ "file.print": ["Ctrl+Shift+P"], "tool.hand": [] });
    const rev = reverseKeymap(km);
    expect(rev.get("Ctrl+Shift+P")).toBe("file.print");
    expect(rev.get("Ctrl+P")).toBeUndefined();
    expect(rev.get("H")).toBeUndefined();
    expect(conflicts(km, "Ctrl+S", "file.print")).toEqual(["file.save"]);
  });

  it("finds commands by words in any order", () => {
    const find = (q: string) => COMMANDS.filter((c) => matchScore(c, q) > 0).sort((a, b) => matchScore(b, q) - matchScore(a, q))[0]?.id;
    expect(find("compress")).toBe("protect.compress");
    expect(find("side by side")).toBe("window.split");
    expect(find("mode edit")).toBe("mode.edit");
    expect(find("ocr")).toBe("protect.ocr");
    expect(find("xyzzy")).toBeUndefined();
  });
});

describe("assistant", () => {
  it("turns page citations into links", () => {
    const parts = withCitations("Rent is due monthly [p. 3]. Notice is 30 days [p. 4–5].");
    expect(parts.filter((p) => p.kind === "cite").map((p) => (p as { page: number }).page)).toEqual([2, 3]);
    expect(parts[0]).toEqual({ kind: "text", text: "Rent is due monthly " });
  });

  it("parses field suggestions defensively", () => {
    expect(parseSuggestions('{"suggestions":[{"field":"name","value":"Ann","page":1,"reason":"Signed by Ann"}]}')).toHaveLength(1);
    expect(parseSuggestions("not json")).toEqual([]);
    expect(parseSuggestions('{"suggestions":[{"field":3}]}')).toEqual([]);
  });
});

describe("batch", () => {
  it("names outputs and knows when passwords are needed", () => {
    expect(outputName("Report.final.pdf", " (processed)")).toBe("Report.final (processed).pdf");
    expect(needsPasswords([newStep("compress")])).toEqual({ owner: false, open: false });
    expect(needsPasswords([{ kind: "protect", requireOpen: true }])).toEqual({ owner: true, open: true });
  });
});

describe("assistant services", () => {
  const settings = (provider: "openai" | "deepseek" | "local", extra: object = {}) => ({
    enabled: true, provider, keys: { openai: "sk-1", deepseek: "ds-1" }, models: { openai: "m1" }, localUrl: "http://localhost:11434/v1", ...extra,
  });
  const streamOf = (lines: string[]) =>
    new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l)); c.close(); } }), { status: 200 });

  it("streams OpenAI-compatible chat completions, even when chunks split lines", async () => {
    const { runAssistant } = await import("../../src/ui/ai/assistant");
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const a = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`;
      const b = `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return streamOf([a.slice(0, 10), a.slice(10) + b]);
    }) as typeof fetch;
    const seen: string[] = [];
    const out = await runAssistant({ settings: settings("openai"), task: { kind: "summary" }, name: "x.pdf", text: "[Page 1]\nhi", onText: (t) => seen.push(t), signal: new AbortController().signal });
    expect(out).toBe("Hello");
    expect(seen.at(-1)).toBe("Hello");
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-1");
  });

  it("asks for JSON the way each service supports, and uses DeepSeek's default model", async () => {
    const { runAssistant } = await import("../../src/ui/ai/assistant");
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return streamOf([`data: ${JSON.stringify({ choices: [{ delta: { content: '{"suggestions":[]}' }, finish_reason: "stop" }] })}\n\n`]);
    }) as typeof fetch;
    const task = { kind: "fields" as const, fields: [] };
    const run = (s: ReturnType<typeof settings>) => runAssistant({ settings: s, task, name: "f.pdf", text: "[Page 1]\nName: Ann", onText: () => {}, signal: new AbortController().signal });
    await run(settings("openai"));
    await run(settings("deepseek"));
    expect((bodies[0].response_format as { type: string }).type).toBe("json_schema");
    expect((bodies[1].response_format as { type: string }).type).toBe("json_object");
    expect(bodies[1].model).toBe("deepseek-chat");
  });

  it("refuses non-local addresses for the local option, and explains HTTP errors", async () => {
    const { runAssistant } = await import("../../src/ui/ai/assistant");
    const opts = (s: ReturnType<typeof settings>) => ({ settings: s, task: { kind: "summary" as const }, name: "x", text: "t", onText: () => {}, signal: new AbortController().signal });
    await expect(runAssistant(opts(settings("local", { localUrl: "https://example.com/v1", models: { local: "llama" } })))).rejects.toThrow(/on this computer/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as typeof fetch;
    await expect(runAssistant(opts(settings("openai")))).rejects.toThrow(/didn't accept the API key/);
  });
});
