// Recently opened files (desktop only: entries need a path to reopen).
import { load, save } from "./settings";

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
  page: number;
  pageCount: number;
  /** Small JPEG data URL of the first page. */
  thumb?: string;
}

export const MAX_RECENT = 12;
const KEY = "recent";

export function addRecent(list: RecentFile[], entry: Omit<RecentFile, "thumb" | "page"> & Partial<RecentFile>): RecentFile[] {
  const prev = list.find((r) => samePath(r.path, entry.path));
  const merged: RecentFile = { page: 0, ...prev, ...entry, thumb: entry.thumb ?? prev?.thumb };
  return [merged, ...list.filter((r) => !samePath(r.path, entry.path))].slice(0, MAX_RECENT);
}

export function updateRecent(list: RecentFile[], path: string, patch: Partial<RecentFile>): RecentFile[] {
  return list.map((r) => (samePath(r.path, path) ? { ...r, ...patch } : r));
}

export function removeRecent(list: RecentFile[], path: string): RecentFile[] {
  return list.filter((r) => !samePath(r.path, path));
}

/** Windows paths are case-insensitive. */
export function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

export const loadRecent = () => load<RecentFile[]>(KEY, []);
export const saveRecent = (list: RecentFile[]) => save(KEY, list);

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return "Just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d > 300 ? "numeric" : undefined });
}
