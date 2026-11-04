import { describe, expect, it } from "vitest";
import { parsePageRange } from "../../src/ui/doc/pageRange";

describe("parsePageRange", () => {
  it("parses single pages, ranges and open ranges", () => {
    expect(parsePageRange("1-3, 5", 10)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange("8-", 10)).toEqual([7, 8, 9]);
    expect(parsePageRange("-2", 10)).toEqual([0, 1]);
    expect(parsePageRange("3-1", 10)).toEqual([0, 1, 2]);
  });
  it("removes duplicates but keeps order", () => {
    expect(parsePageRange("5, 1-2, 2", 10)).toEqual([4, 0, 1]);
  });
  it("explains mistakes", () => {
    expect(parsePageRange("", 10)).toMatch(/Enter pages/);
    expect(parsePageRange("abc", 10)).toMatch(/isn't a page/);
    expect(parsePageRange("12", 10)).toMatch(/has 10 pages/);
    expect(parsePageRange("0", 10)).toMatch(/start at 1/);
  });
});
