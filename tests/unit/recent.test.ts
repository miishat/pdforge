import { describe, expect, it } from "vitest";
import { addRecent, MAX_RECENT, removeRecent, samePath, timeAgo, updateRecent, type RecentFile } from "../../src/ui/recent";

const e = (path: string, openedAt = 1): Omit<RecentFile, "page" | "thumb"> => ({ path, name: path, openedAt, pageCount: 3 });

describe("recent files", () => {
  it("puts the newest first and dedupes case-insensitively", () => {
    let list = addRecent([], e("C:\\a.pdf"));
    list = addRecent(list, e("C:\\b.pdf"));
    list = addRecent(list, e("c:/A.PDF", 5));
    expect(list.map((r) => r.path)).toEqual(["c:/A.PDF", "C:\\b.pdf"]);
  });
  it("keeps the remembered page and thumbnail when re-adding", () => {
    let list = addRecent([], { ...e("x.pdf"), thumb: "data:1" });
    list = updateRecent(list, "x.pdf", { page: 7 });
    list = addRecent(list, e("x.pdf", 9));
    expect(list[0]).toMatchObject({ page: 7, thumb: "data:1", openedAt: 9 });
  });
  it("caps the list length and removes entries", () => {
    let list: RecentFile[] = [];
    for (let i = 0; i < 20; i++) list = addRecent(list, e(`f${i}.pdf`));
    expect(list).toHaveLength(MAX_RECENT);
    expect(removeRecent(list, "f19.pdf")).toHaveLength(MAX_RECENT - 1);
  });
  it("compares Windows paths", () => {
    expect(samePath("C:\\Docs\\X.pdf", "c:/docs/x.pdf")).toBe(true);
  });
  it("describes times in plain words", () => {
    const now = 10 * 86400_000;
    expect(timeAgo(now - 5_000, now)).toBe("Just now");
    expect(timeAgo(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(timeAgo(now - 86400_000, now)).toBe("Yesterday");
  });
});
