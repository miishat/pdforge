// Finding tables on pages and exporting them as CSV or Excel workbooks.
// Detection is layout-based: text pieces are grouped into rows by their vertical position, and
// columns are the vertical strips of whitespace shared by consecutive rows. This finds most
// tables in reports and statements, ruled or not; merged cells and nested tables are flattened.
import * as mupdf from "mupdf";
import type { Rect } from "./types";
import { zip } from "./zip";

export interface Table {
  page: number;
  /** Bounding box in page space. */
  rect: Rect;
  rows: string[][];
}

interface WordBox {
  text: string;
  x0: number;
  x1: number;
}

interface Piece {
  text: string;
  /** The words inside, for finding narrow column gaps. */
  words: WordBox[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  size: number;
}

interface Row {
  y0: number;
  y1: number;
  cells: Piece[];
}

/** Text pieces of a page: runs of characters without a wide gap between them. */
function pieces(page: mupdf.Page): Piece[] {
  const st = page.toStructuredText("preserve-whitespace");
  const out: Piece[] = [];
  let cur: Piece | null = null;
  let word: WordBox | null = null;
  let lastX1 = 0;
  const endWord = () => {
    if (cur && word && word.text) cur.words.push(word);
    word = null;
  };
  const flush = () => {
    endWord();
    if (cur && cur.text.trim()) out.push({ ...cur, text: cur.text.trim() });
    cur = null;
  };
  st.walk({
    beginLine() {
      flush();
    },
    onChar(c, _o, _f, size, quad) {
      const x0 = Math.min(quad[0], quad[4]);
      const x1 = Math.max(quad[2], quad[6]);
      const y0 = Math.min(quad[1], quad[3]);
      const y1 = Math.max(quad[5], quad[7]);
      // A gap wider than about one em separates cells even within one line of text.
      if (cur && x0 - lastX1 > size * 0.9) flush();
      if (!cur) cur = { text: "", words: [], x0, x1, y0, y1, size };
      cur.text += c;
      if (c.trim()) {
        if (!word) word = { text: "", x0, x1 };
        word.text += c;
        word.x1 = Math.max(word.x1, x1);
        cur.x1 = Math.max(cur.x1, x1);
        lastX1 = x1;
      } else endWord();
      cur.y0 = Math.min(cur.y0, y0);
      cur.y1 = Math.max(cur.y1, y1);
    },
    endLine() {
      flush();
    },
  });
  flush();
  st.destroy();
  return out;
}

function rowsOf(ps: Piece[]): Row[] {
  const sorted = [...ps].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const rows: Row[] = [];
  for (const p of sorted) {
    const mid = (p.y0 + p.y1) / 2;
    const row = rows.find((r) => mid > r.y0 && mid < r.y1 && Math.abs((r.y0 + r.y1) / 2 - mid) < (p.y1 - p.y0) * 0.6);
    if (row) {
      row.cells.push(p);
      row.y0 = Math.min(row.y0, p.y0);
      row.y1 = Math.max(row.y1, p.y1);
    } else rows.push({ y0: p.y0, y1: p.y1, cells: [p] });
  }
  for (const r of rows) r.cells.sort((a, b) => a.x0 - b.x0);
  return rows.sort((a, b) => a.y0 - b.y0);
}

/**
 * Column strips: the x ranges covered by words in any of the rows. A strip of whitespace that no
 * row crosses, however narrow, separates two columns.
 */
function columnsOf(rows: Row[]): [number, number][] {
  const spans = rows.flatMap((r) => r.cells.flatMap((c) => c.words.map((w) => [w.x0, w.x1] as [number, number]))).sort((a, b) => a[0] - b[0]);
  const cols: [number, number][] = [];
  for (const [x0, x1] of spans) {
    const last = cols[cols.length - 1];
    if (last && x0 <= last[1] + 0.5) last[1] = Math.max(last[1], x1);
    else cols.push([x0, x1]);
  }
  return cols;
}

const colOf = (cols: [number, number][], w: WordBox) => cols.findIndex(([x0, x1]) => w.x0 >= x0 - 0.5 && w.x1 <= x1 + 0.5);

function toTable(page: number, rows: Row[], cols: [number, number][]): Table {
  const grid = rows.map((r) => {
    const cells = cols.map(() => [] as string[]);
    // Top to bottom, then left to right, so wrapped cell text reads in order.
    const ordered = [...r.cells].sort((a, b) => (Math.abs(a.y0 - b.y0) > 2 ? a.y0 - b.y0 : a.x0 - b.x0));
    for (const c of ordered) for (const w of c.words) cells[Math.max(0, colOf(cols, w))].push(w.text);
    return cells.map((parts) => parts.join(" "));
  });
  const xs = rows.flatMap((r) => r.cells);
  return {
    page,
    rect: [Math.min(...xs.map((c) => c.x0)), rows[0].y0, Math.max(...xs.map((c) => c.x1)), rows[rows.length - 1].y1],
    rows: grid,
  };
}

/** Tables on one page. */
export function findTables(page: mupdf.Page, index: number): Table[] {
  const rows = rowsOf(pieces(page));
  const tables: Table[] = [];
  let block: Row[] = [];
  const close = () => {
    const t = tableFrom(block, index);
    if (t) tables.push(t);
    block = [];
  };
  for (const r of rows) {
    const prev = block[block.length - 1];
    const h = r.y1 - r.y0;
    if (r.cells.length < 2 && prev && r.y0 - prev.y1 <= h * 2.2) {
      // Cells only a space apart come out as one piece: accept it when its words fall into the
      // table's existing columns.
      const cols = columnsOf(block);
      const ws = r.cells[0].words;
      const idx = ws.map((w) => colOf(cols, w));
      if (cols.length >= 2 && idx.every((i) => i >= 0) && new Set(idx).size >= 2) {
        block.push(r);
        continue;
      }
    }
    if (r.cells.length < 2) {
      // A wrapped cell: one piece just below the last row, within the table's width.
      const left = prev ? Math.min(...block.flatMap((b) => b.cells.map((c) => c.x0))) : 0;
      const right = prev ? Math.max(...block.flatMap((b) => b.cells.map((c) => c.x1))) : 0;
      const c = r.cells[0];
      if (prev && r.y0 - prev.y1 < h * 0.6 && c.x0 >= left - 1 && c.x1 <= right + 1 && c.x1 - c.x0 < (right - left) * 0.6) {
        prev.cells.push(c);
        prev.y1 = Math.max(prev.y1, r.y1);
        continue;
      }
      close();
      continue;
    }
    if (prev && r.y0 - prev.y1 > h * 2.2) close();
    block.push(r);
  }
  close();
  return tables;
}

/** A block of multi-cell rows is a table when its columns line up: at least 2 rows and 2 columns. */
function tableFrom(rows: Row[], page: number): Table | null {
  // Trim rows from the end until the columns line up (a closing paragraph line may join the block).
  for (let end = rows.length; end >= 2; end--) {
    const part = rows.slice(0, end);
    const cols = columnsOf(part);
    if (cols.length < 2) continue;
    // Every row must use at least two columns.
    const used = part.map((r) => new Set(r.cells.flatMap((c) => c.words.map((w) => colOf(cols, w)))));
    if (!used.every((u) => u.size >= 2)) continue;
    // Rows×columns this small are as likely to be a two-column layout; require some density.
    const filled = used.reduce((n, u) => n + u.size, 0);
    if (part.length < 3 && cols.length < 3) continue;
    if (filled < part.length * cols.length * 0.5) continue;
    return toTable(page, part, cols);
  }
  return null;
}

export function findAllTables(doc: mupdf.Document, pages?: number[]): Table[] {
  const list = pages ?? Array.from({ length: doc.countPages() }, (_, i) => i);
  const out: Table[] = [];
  for (const i of list) {
    const page = doc.loadPage(i);
    try {
      out.push(...findTables(page, i));
    } finally {
      page.destroy();
    }
  }
  return out;
}

// ---- Export ----

/** RFC 4180 CSV with CRLF line ends and a UTF-8 byte-order mark (so Excel reads accents correctly). */
export function toCsv(rows: string[][]): string {
  const field = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return "﻿" + rows.map((r) => r.map(field).join(",")).join("\r\n") + "\r\n";
}

const NUMBER = /^[-−]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

/** An Excel workbook with one sheet per table. Numbers become numeric cells. */
export async function toXlsx(tables: { name: string; rows: string[][] }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const x = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const col = (i: number) => {
    let s = "";
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  };
  const names = uniqueSheetNames(tables.map((t) => t.name));
  const sheets = tables.map((t) => {
    const rows = t.rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            const ref = `${col(ci)}${ri + 1}`;
            if (!v) return "";
            if (NUMBER.test(v)) return `<c r="${ref}"><v>${v.replace(/,/g, "").replace("−", "-")}</v></c>`;
            return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${x(v)}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${x(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  // Style 1 = bold, used for the first row.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(types) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(s) })),
  ]);
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, unique. */
export function uniqueSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = (raw.replace(/[[\]:*?/\\]/g, " ").trim() || "Sheet").slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}
