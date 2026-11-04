import { describe, expect, it } from "vitest";
import { colorToHex, formatArea, formatLength, hexToColor, pathLength, polygonArea, styleGroup } from "../../src/ui/doc/tools";

describe("annotation tools", () => {
  it("converts colours both ways", () => {
    expect(colorToHex(hexToColor("#2F7CF6"))).toBe("#2F7CF6");
    expect(colorToHex(null)).toBeNull();
  });
  it("measures lengths and areas at a scale", () => {
    expect(formatLength(144, { ratio: 1, unit: "in" })).toBe("2.00 in");
    expect(formatLength(72, { ratio: 100, unit: "ft" })).toBe("100.0 ft");
    expect(formatArea(72 * 72 * 3, { ratio: 1, unit: "in" })).toBe("3.00 sq in");
    expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100);
    expect(pathLength([[0, 0], [3, 4], [3, 10]])).toBe(11);
    expect(pathLength([[0, 0], [3, 0], [3, 4]], true)).toBe(12);
  });
  it("groups tools that share a style", () => {
    expect(styleGroup("callout")).toBe("text");
    expect(styleGroup("ellipse")).toBe("shape");
    expect(styleGroup("area")).toBe("measure");
  });
});
