/**
 * Parses "1-3, 5, 8-" style page ranges (1-based, as typed) into 0-based page indices.
 * Returns an error message for anything it can't understand.
 */
export function parsePageRange(input: string, count: number): number[] | string {
  const parts = input.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "Enter pages like 1-3, 5.";
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    const m = /^(\d*)\s*(?:[-–]\s*(\d*))?$/.exec(part);
    if (!m || (!m[1] && !m[2])) return `"${part}" isn't a page or range.`;
    const isRange = part.includes("-") || part.includes("–");
    const a = m[1] ? Number(m[1]) : 1;
    const b = isRange ? (m[2] ? Number(m[2]) : count) : a;
    if (a < 1 || b < 1) return "Page numbers start at 1.";
    if (a > count || b > count) return `This document has ${count} page${count === 1 ? "" : "s"}.`;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let p = lo; p <= hi; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p - 1);
      }
    }
  }
  return out;
}
