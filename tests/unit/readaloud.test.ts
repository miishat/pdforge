import { describe, expect, it } from "vitest";
import { chunkText } from "../../src/ui/doc/useReadAloud";

describe("chunkText", () => {
  it("groups sentences up to the size limit", () => {
    expect(chunkText("One. Two! Three?", 10)).toEqual(["One. Two!", "Three?"]);
  });
  it("splits a very long sentence", () => {
    const chunks = chunkText("a".repeat(500), 220);
    expect(chunks.map((c) => c.length)).toEqual([220, 220, 60]);
  });
  it("returns nothing for blank pages", () => {
    expect(chunkText(" \n ")).toEqual([]);
  });
});
