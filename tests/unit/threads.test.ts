import { describe, expect, it } from "vitest";
import { buildThreads } from "../../src/ui/doc/CommentsPanel";
import type { AnnotationInfo } from "../../src/core/types";

const a = (id: number, extra: Partial<AnnotationInfo> = {}): AnnotationInfo => ({
  id, page: 0, type: "Text", rect: [0, 0, 1, 1], contents: `c${id}`, author: "x", subject: "", modified: null, created: `2026-01-0${id}`,
  color: null, interiorColor: null, opacity: 1, borderWidth: 0, inReplyTo: null, state: null, icon: null, intent: null,
  lineEndings: null, fontSize: null, hidden: false, resizable: false, ...extra,
});

describe("comment threads", () => {
  it("groups nested replies under the root and takes the latest status", () => {
    const t = buildThreads([
      a(1),
      a(2, { inReplyTo: 1 }),
      a(3, { inReplyTo: 2 }),
      a(4, { inReplyTo: 1, state: "Accepted" }),
      a(5, { inReplyTo: 1, state: "Completed" }),
      a(6),
    ]);
    expect(t.map((x) => x.root.id)).toEqual([1, 6]);
    expect(t[0].replies.map((r) => r.id)).toEqual([2, 3]);
    expect(t[0].status).toBe("Completed");
  });
  it("treats replies to missing parents as roots", () => {
    expect(buildThreads([a(7, { inReplyTo: 99 })]).map((x) => x.root.id)).toEqual([7]);
  });
});
