// Converting PDFs to other formats and other formats to PDF.
// Reflowed exports (Markdown, HTML, Word) are best effort: PDF has positioned glyphs, not
// paragraphs, so structure is inferred from font sizes, spacing and list markers.
import * as mupdf from "mupdf";
import { concat, deflate, zip } from "./zip";

// ---- Document model inferred from the page layout ----

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { kind: "paragraph"; runs: Run[] }
  | { kind: "item"; ordered: boolean; runs: Run[] }
  | { kind: "image"; png: Uint8Array; width: number; height: number }
  | { kind: "page-break" };

interface Char {
  c: string;
  size: number;
  bold: boolean;
  italic: boolean;
  mono: boolean;
}
interface RawLine {
  chars: Char[];
  bbox: number[];
}
type RawBlock = { kind: "text"; lines: RawLine[] } | { kind: "image"; png: Uint8Array; width: number; height: number };

const BULLET = /^\s*([•●▪◦‣■□➢►–—*-])\s+/;
const NUMBERED = /^\s*(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/;

/** Reads the pages into blocks of headings, paragraphs, list items and images. */
export function documentModel(doc: mupdf.Document, opts: { images: boolean; pages?: number[] }): Block[] {
  const indices = opts.pages ?? Array.from({ length: doc.countPages() }, (_, i) => i);
  const raw = indices.map((i) => readRaw(doc, i, opts.images));
  const body = bodySize(raw.flat());
  const out: Block[] = [];
  raw.forEach((blocks, n) => {
    if (n > 0) out.push({ kind: "page-break" });
    for (const b of blocks) {
      if (b.kind === "image") out.push(b);
      else out.push(...paragraphs(b.lines, body));
    }
  });
  return out;
}

function readRaw(doc: mupdf.Document, index: number, images: boolean): RawBlock[] {
  const page = doc.loadPage(index);
  const st = page.toStructuredText(images ? "preserve-images,preserve-whitespace,dehyphenate" : "preserve-whitespace,dehyphenate");
  const blocks: RawBlock[] = [];
  let current: RawLine[] | null = null;
  let line: RawLine | null = null;
  const fonts = new Map<string, { bold: boolean; italic: boolean; mono: boolean }>();
  st.walk({
    onImageBlock(bbox, _m, image) {
      try {
        const pix = image.toPixmap();
        const rgb = pix.getColorSpace()?.isRGB() || pix.getColorSpace()?.isGray() ? pix : pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
        blocks.push({ kind: "image", png: rgb.asPNG().slice(), width: bbox[2] - bbox[0], height: bbox[3] - bbox[1] });
      } catch {
        // Images MuPDF can't decode are left out.
      }
    },
    beginTextBlock() {
      current = [];
    },
    beginLine(bbox) {
      line = { chars: [], bbox: [...bbox] };
    },
    onChar(c, _o, font, size) {
      const name = font.getName();
      let style = fonts.get(name);
      if (!style) {
        style = {
          bold: font.isBold() || /bold|black|heavy|semibold/i.test(name),
          italic: font.isItalic() || /italic|oblique/i.test(name),
          mono: font.isMono() || /mono|courier|consol/i.test(name),
        };
        fonts.set(name, style);
      }
      font.destroy(); // only its name and style were needed
      line?.chars.push({ c, size, ...style });
    },
    endLine() {
      if (line && current && line.chars.some((ch) => ch.c.trim())) current.push(line);
      line = null;
    },
    endTextBlock() {
      if (current?.length) blocks.push({ kind: "text", lines: current });
      current = null;
    },
  });
  st.destroy();
  page.destroy();
  return blocks;
}

/** The most common text size, weighted by characters: the "body" size. */
function bodySize(blocks: RawBlock[]): number {
  const counts = new Map<number, number>();
  for (const b of blocks) {
    if (b.kind !== "text") continue;
    for (const l of b.lines) for (const ch of l.chars) {
      const s = Math.round(ch.size * 2) / 2;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  let best = 12;
  let n = 0;
  for (const [s, c] of counts) if (c > n) [best, n] = [s, c];
  return best;
}

function paragraphs(lines: RawLine[], body: number): Block[] {
  const out: Block[] = [];
  let group: RawLine[] = [];
  const flush = () => {
    if (group.length) out.push(toBlock(group, body));
    group = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = group[group.length - 1];
    const text = l.chars.map((c) => c.c).join("");
    if (prev) {
      const h = prev.bbox[3] - prev.bbox[1];
      const gap = l.bbox[1] - prev.bbox[3];
      const sizeChange = Math.abs(avgSize(l) - avgSize(prev)) > 1;
      if (gap > h * 0.8 || sizeChange || BULLET.test(text) || NUMBERED.test(text)) flush();
    }
    group.push(l);
  }
  flush();
  return out;
}

function avgSize(l: RawLine): number {
  return l.chars.reduce((n, c) => n + c.size, 0) / Math.max(1, l.chars.length);
}

function toBlock(lines: RawLine[], body: number): Block {
  const chars: Char[] = [];
  lines.forEach((l, i) => {
    if (i > 0) {
      const last = chars[chars.length - 1];
      // dehyphenate already joined split words; otherwise lines meet with a space.
      if (last && !/\s/.test(last.c)) chars.push({ ...last, c: " " });
    }
    chars.push(...l.chars);
  });
  let runs = toRuns(chars);
  const text = runs.map((r) => r.text).join("");
  const size = chars.reduce((n, c) => n + c.size, 0) / Math.max(1, chars.length);
  const words = text.trim().split(/\s+/).length;
  const bullet = BULLET.exec(text);
  const numbered = NUMBERED.exec(text);
  if (bullet || numbered) {
    runs = stripPrefix(runs, (bullet ?? numbered)![0].length);
    return { kind: "item", ordered: !bullet, runs };
  }
  if (size >= body * 1.15 && words <= 20) {
    const ratio = size / body;
    return { kind: "heading", level: ratio >= 1.75 ? 1 : ratio >= 1.35 ? 2 : 3, runs: runs.map((r) => ({ ...r, bold: false })) };
  }
  return { kind: "paragraph", runs };
}

function toRuns(chars: Char[]): Run[] {
  const runs: Run[] = [];
  for (const ch of chars) {
    const last = runs[runs.length - 1];
    // Spaces don't start a new run, so "bold word bold" stays one run.
    if (last && (ch.c === " " || (last.bold === ch.bold && last.italic === ch.italic && last.mono === ch.mono))) last.text += ch.c;
    else runs.push({ text: ch.c, bold: ch.bold, italic: ch.italic, mono: ch.mono });
  }
  return runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, " ") })).filter((r) => r.text.length);
}

function stripPrefix(runs: Run[], n: number): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (n <= 0) out.push(r);
    else if (r.text.length <= n) n -= r.text.length;
    else {
      out.push({ ...r, text: r.text.slice(n) });
      n = 0;
    }
  }
  return out;
}


// ---- Plain text ----

/** Text in reading order; pages are separated by a form feed, as pdftotext does. */
export function toText(doc: mupdf.Document, pages?: number[]): string {
  const indices = pages ?? Array.from({ length: doc.countPages() }, (_, i) => i);
  return indices
    .map((i) => {
      const page = doc.loadPage(i);
      const st = page.toStructuredText("preserve-whitespace,dehyphenate");
      const t = st.asText();
      st.destroy();
      page.destroy();
      return t.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    })
    .join("\f");
}

// ---- Markdown ----

export function toMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  let n = 0;
  let prevKind = "";
  for (const b of blocks) {
    if (b.kind === "page-break") {
      out.push("\n---\n");
      prevKind = "";
      continue;
    }
    if (b.kind === "image") {
      out.push(`![](data:image/png;base64,${base64(b.png)})\n`);
    } else if (b.kind === "heading") {
      out.push(`${"#".repeat(b.level)} ${mdRuns(b.runs)}\n`);
    } else if (b.kind === "item") {
      n = prevKind === "item" ? n + 1 : 1;
      out.push(`${b.ordered ? `${n}.` : "-"} ${mdRuns(b.runs)}`);
      prevKind = "item";
      continue;
    } else {
      out.push(`${mdRuns(b.runs)}\n`);
    }
    if (prevKind === "item") out.splice(out.length - 1, 0, "");
    prevKind = b.kind;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function mdRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      const t = r.text;
      const core = t.trim();
      if (!core) return t;
      let s = escapeMd(core);
      if (r.mono) s = "`" + core.replace(/`/g, "") + "`";
      else {
        if (r.bold) s = `**${s}**`;
        if (r.italic) s = `*${s}*`;
      }
      // Keep the spaces outside the markers, or Markdown won't recognise them.
      return (t.startsWith(" ") ? " " : "") + s + (t.endsWith(" ") ? " " : "");
    })
    .join("")
    .trim();
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]#<>|])/g, "\\$1").replace(/^(\d+)\. /, "$1\\. ");
}

// ---- HTML ----

export function toHtml(blocks: Block[], title: string): string {
  const body: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => {
    if (list) body.push(`</${list}>`);
    list = null;
  };
  for (const b of blocks) {
    if (b.kind !== "item") close();
    if (b.kind === "page-break") body.push('<hr class="page">');
    else if (b.kind === "image") body.push(`<p><img src="data:image/png;base64,${base64(b.png)}" width="${Math.round(b.width)}" alt=""></p>`);
    else if (b.kind === "heading") body.push(`<h${b.level}>${htmlRuns(b.runs)}</h${b.level}>`);
    else if (b.kind === "item") {
      const want = b.ordered ? "ol" : "ul";
      if (list !== want) {
        close();
        body.push(`<${want}>`);
        list = want;
      }
      body.push(`<li>${htmlRuns(b.runs)}</li>`);
    } else body.push(`<p>${htmlRuns(b.runs)}</p>`);
  }
  close();
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.55 "Segoe UI", system-ui, sans-serif; color: #222; }
img { max-width: 100%; height: auto; }
hr.page { border: 0; border-top: 1px dashed #bbb; margin: 2.5rem 0; }
code { font-family: Consolas, monospace; }
</style>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}

function htmlRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      const core = r.text.trim();
      if (!core) return r.text;
      let s = escapeHtml(core);
      if (r.mono) s = `<code>${s}</code>`;
      if (r.bold) s = `<strong>${s}</strong>`;
      if (r.italic) s = `<em>${s}</em>`;
      return (r.text.startsWith(" ") ? " " : "") + s + (r.text.endsWith(" ") ? " " : "");
    })
    .join("")
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---- Word (DOCX) ----

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A Word document with headings, paragraphs, lists, bold/italic and images. */
export async function toDocx(blocks: Block[], title: string): Promise<Uint8Array> {
  const media: { name: string; data: Uint8Array }[] = [];
  const rels: string[] = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
  ];
  const body: string[] = [];
  for (const b of blocks) {
    if (b.kind === "page-break") body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else if (b.kind === "heading") body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${b.level}"/></w:pPr>${docxRuns(b.runs)}</w:p>`);
    else if (b.kind === "paragraph") body.push(`<w:p>${docxRuns(b.runs)}</w:p>`);
    else if (b.kind === "item") {
      const numId = b.ordered ? 2 : 1;
      body.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${docxRuns(b.runs)}</w:p>`);
    } else if (b.kind === "image") {
      const n = media.length + 1;
      const name = `image${n}.png`;
      media.push({ name, data: b.png });
      rels.push(`<Relationship Id="rIdImg${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      // Size in EMUs (914400 per inch, 12700 per point), capped to the text width (6.5in).
      const scale = Math.min(1, 468 / Math.max(1, b.width));
      const cx = Math.round(b.width * scale * 12700);
      const cy = Math.round(b.height * scale * 12700);
      body.push(drawing(n, cx, cy));
    }
  }
  const enc = new TextEncoder();
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeHtml(title)}</dc:title><dc:creator>PDForge</dc:creator></cp:coreProperties>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "docProps/core.xml", data: enc.encode(core) },
    { name: "word/document.xml", data: enc.encode(document) },
    { name: "word/styles.xml", data: enc.encode(STYLES) },
    { name: "word/numbering.xml", data: enc.encode(NUMBERING) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(docRels) },
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
  ], { store: media.map((m) => `word/media/${m.name}`) });
}

function docxRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      const props = [r.bold ? "<w:b/>" : "", r.italic ? "<w:i/>" : "", r.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ""].join("");
      return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(r.text)}</w:t></w:r>`;
    })
    .join("");
}

function drawing(n: number, cx: number, cy: number): string {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1, 2, 3]
  .map((l) => `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${l === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${l - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[0, 36, 30, 26][l]}"/></w:rPr></w:style>`)
  .join("")}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style></w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;

function escapeXml(s: string): string {
  // XML 1.0 can't carry most control characters at all.
  return escapeHtml(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

// ---- Images ----

/** A TIFF (one page per image), RGB, Deflate-compressed, with the resolution recorded. */
export async function toTiff(pages: { width: number; height: number; rgb: Uint8Array; dpi: number }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array([0x49, 0x49, 42, 0, 0, 0, 0, 0]); // little-endian, first IFD offset patched below
  parts.push(header);
  let offset = 8;
  const ifdOffsets: number[] = [];
  const nextPointers: { part: Uint8Array; at: number }[] = [];
  for (const p of pages) {
    const data = await deflate(p.rgb);
    const dataOffset = offset;
    parts.push(data);
    offset += data.length;
    if (offset % 2) {
      parts.push(new Uint8Array(1));
      offset++;
    }
    // Extra values that don't fit in a tag: BitsPerSample (3 shorts) and two resolutions (rationals).
    const extra = new DataView(new ArrayBuffer(6 + 2 + 16));
    const bpsOffset = offset;
    extra.setUint16(0, 8, true);
    extra.setUint16(2, 8, true);
    extra.setUint16(4, 8, true);
    const xresOffset = offset + 8;
    extra.setUint32(8, Math.round(p.dpi), true);
    extra.setUint32(12, 1, true);
    extra.setUint32(16, Math.round(p.dpi), true);
    extra.setUint32(20, 1, true);
    parts.push(new Uint8Array(extra.buffer));
    offset += extra.byteLength;
    const tags: [number, number, number, number][] = [
      [256, 4, 1, p.width], // ImageWidth
      [257, 4, 1, p.height], // ImageLength
      [258, 3, 3, bpsOffset], // BitsPerSample
      [259, 3, 1, 8], // Compression: Deflate
      [262, 3, 1, 2], // Photometric: RGB
      [273, 4, 1, dataOffset], // StripOffsets
      [277, 3, 1, 3], // SamplesPerPixel
      [278, 4, 1, p.height], // RowsPerStrip
      [279, 4, 1, data.length], // StripByteCounts
      [282, 5, 1, xresOffset], // XResolution
      [283, 5, 1, xresOffset + 8], // YResolution
      [284, 3, 1, 1], // PlanarConfiguration: chunky
      [296, 3, 1, 2], // ResolutionUnit: inch
    ];
    const ifd = new DataView(new ArrayBuffer(2 + tags.length * 12 + 4));
    ifd.setUint16(0, tags.length, true);
    tags.forEach(([tag, type, count, value], i) => {
      const o = 2 + i * 12;
      ifd.setUint16(o, tag, true);
      ifd.setUint16(o + 2, type, true);
      ifd.setUint32(o + 4, count, true);
      if (type === 3 && count === 1) ifd.setUint16(o + 8, value, true);
      else ifd.setUint32(o + 8, value, true);
    });
    ifdOffsets.push(offset);
    const part = new Uint8Array(ifd.buffer);
    nextPointers.push({ part, at: part.length - 4 });
    parts.push(part);
    offset += part.length;
  }
  new DataView(header.buffer).setUint32(4, ifdOffsets[0] ?? 0, true);
  nextPointers.forEach(({ part, at }, i) => new DataView(part.buffer).setUint32(at, ifdOffsets[i + 1] ?? 0, true));
  return concat(parts);
}

// ---- Other formats to PDF ----

/** File types MuPDF can lay out and turn into PDF pages. */
export const IMPORTABLE: Record<string, { mime: string; label: string }> = {
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint" },
  html: { mime: "text/html", label: "Web page" },
  htm: { mime: "text/html", label: "Web page" },
  xhtml: { mime: "application/xhtml+xml", label: "Web page" },
  txt: { mime: "text/plain", label: "Text" },
  md: { mime: "text/plain", label: "Text" },
  epub: { mime: "application/epub+zip", label: "EPUB" },
  fb2: { mime: "application/x-fictionbook", label: "FictionBook" },
  cbz: { mime: "application/x-cbz", label: "Comic book" },
  png: { mime: "image/png", label: "Image" },
  jpg: { mime: "image/jpeg", label: "Image" },
  jpeg: { mime: "image/jpeg", label: "Image" },
  gif: { mime: "image/gif", label: "Image" },
  bmp: { mime: "image/bmp", label: "Image" },
  tif: { mime: "image/tiff", label: "Image" },
  tiff: { mime: "image/tiff", label: "Image" },
  jxr: { mime: "image/jxr", label: "Image" },
  pnm: { mime: "image/x-portable-anymap", label: "Image" },
};

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "jxr", "pnm"];

/**
 * Lays out a document (Office, web page, text, e-book, image) and writes it as a PDF.
 * Text stays text. Images become pages at their own resolution (or fitted on a paper size).
 */
export function convertToPdf(
  files: { name: string; bytes: Uint8Array }[],
  opts: { pageSize?: [number, number]; margin?: number; fitImages?: boolean } = {},
): Uint8Array {
  const buf = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buf, "pdf", "compress");
  let pages = 0;
  try {
    for (const f of files) {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      const kind = IMPORTABLE[ext];
      if (!kind) throw new Error(`${f.name}: PDForge can't convert .${ext} files.`);
      let doc: mupdf.Document;
      try {
        doc = mupdf.Document.openDocument(f.bytes, kind.mime);
      } catch (err) {
        throw new Error(`${f.name} couldn't be read (${err instanceof Error ? err.message : String(err)}).`);
      }
      if (!IMAGE_EXTS.includes(ext) && opts.pageSize) {
        // Reflowable formats take the chosen paper size; 11pt matches common word-processor defaults.
        const [w, h] = opts.pageSize;
        safe(() => doc.layout(w, h, 11));
      }
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.loadPage(i);
        const bounds = page.getBounds();
        let box = bounds;
        let ctm = mupdf.Matrix.identity;
        if (IMAGE_EXTS.includes(ext) && opts.pageSize && opts.fitImages !== false) {
          // Fit the image on the paper, centred within the margins.
          const [pw, ph] = opts.pageSize;
          const m = opts.margin ?? 36;
          const bw = bounds[2] - bounds[0];
          const bh = bounds[3] - bounds[1];
          const portrait = bh >= bw;
          const [W, H] = portrait === ph >= pw ? [pw, ph] : [ph, pw];
          const s = Math.min((W - 2 * m) / bw, (H - 2 * m) / bh);
          box = [0, 0, W, H];
          ctm = mupdf.Matrix.concat(mupdf.Matrix.translate(-bounds[0], -bounds[1]), mupdf.Matrix.concat(mupdf.Matrix.scale(s, s), mupdf.Matrix.translate((W - bw * s) / 2, (H - bh * s) / 2)));
        }
        const dev = writer.beginPage(box);
        page.run(dev, ctm);
        writer.endPage();
        page.destroy();
        pages++;
      }
      doc.destroy();
    }
    writer.close();
  } catch (err) {
    safe(() => writer.close());
    throw err;
  }
  if (pages === 0) throw new Error("There was nothing to convert.");
  return buf.asUint8Array().slice();
}

export function base64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

function safe(fn: () => void) {
  try {
    fn();
  } catch {
    // ignore
  }
}
