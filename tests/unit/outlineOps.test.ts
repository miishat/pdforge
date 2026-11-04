import { describe, expect, it } from "vitest";
import { outlineOps } from "../../src/ui/doc/BookmarkEditor";

type N = { title: string; page: number; children: N[] };
const n = (title: string, children: N[] = []): N => ({ title, page: 0, children });
const titles = (t: { title: string; children: unknown[] }[]): unknown => t.map((x) => (x.children.length ? [x.title, titles(x.children as never)] : x.title));

describe("bookmark tree edits", () => {
  const tree = [n("A"), n("B", [n("B1"), n("B2")]), n("C")];
  it("moves, indents and outdents", () => {
    expect(titles(outlineOps.move(tree, [2], -1))).toEqual(["A", "C", ["B", ["B1", "B2"]]]);
    expect(titles(outlineOps.indent(tree, [2]))).toEqual(["A", ["B", ["B1", "B2", "C"]]]);
    expect(titles(outlineOps.outdent(tree, [1, 0]))).toEqual(["A", ["B", ["B2"]], "B1", "C"]);
    expect(outlineOps.indent(tree, [0])).toBe(tree);
  });
  it("adds after a bookmark, renames and removes without changing the original", () => {
    const [t, path] = outlineOps.add(tree, [1, 0], n("new"));
    expect(path).toEqual([1, 1]);
    expect(titles(t)).toEqual(["A", ["B", ["B1", "new", "B2"]], "C"]);
    expect(titles(outlineOps.remove(outlineOps.rename(tree, [0], "Intro"), [2]))).toEqual(["Intro", ["B", ["B1", "B2"]]]);
    expect(titles(tree)).toEqual(["A", ["B", ["B1", "B2"]], "C"]);
  });
});
