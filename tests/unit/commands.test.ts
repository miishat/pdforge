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
