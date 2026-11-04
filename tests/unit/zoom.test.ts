import { describe, expect, it } from "vitest";
import { clampZoom, formatZoom, stepZoom } from "../../src/ui/zoom";

describe("zoom", () => {
  it("steps to the next preset in each direction", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.17, 1)).toBe(1.25);
    expect(stepZoom(1.17, -1)).toBe(1.1);
  });
  it("stops at the limits", () => {
    expect(stepZoom(8, 1)).toBe(8);
    expect(stepZoom(0.1, -1)).toBe(0.1);
    expect(clampZoom(20)).toBe(8);
  });
  it("formats as a whole percentage", () => {
    expect(formatZoom(1.254)).toBe("125%");
  });
});
