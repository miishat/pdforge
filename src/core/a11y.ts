// Accessibility checks (modelled on the PDF/UA and WCAG checks screen-reader users rely on most)
// and fix-ups for the simple ones. Tagging an untagged document properly needs the source
// application, so that is reported rather than attempted.
import * as mupdf from "mupdf";
import type { OutlineEdit } from "./content";
import { documentModel } from "./convert";

export type A11yStatus = "pass" | "fail" | "warn" | "manual";

export interface A11yCheck {
  id: string;
  label: string;
  status: A11yStatus;
  detail?: string;
  /** A fix-up PDForge can apply for this check. */
  fix?: "language" | "title" | "tabOrder" | "tooltips" | "linkText" | "bookmarks" | "altText" | "ocr";
}

export interface Figure {
  /** Object number of the structure element. */
  id: number;
  page: number | null;
  alt: string;
}

export interface A11yReport {
  checks: A11yCheck[];
  /** Tagged figures, for adding alt text. */
  figures: Figure[];
  /** Suggested values for fix-ups. */
  suggested: { language: string; title: string };
}

export interface A11yFixes {
  language?: string;
  title?: string;
  tabOrder?: boolean;
  tooltips?: boolean;
  linkText?: boolean;
  bookmarks?: boolean;
  alt?: { id: number; text: string }[];
}

/** Follows a path of keys; missing steps give a null object instead of throwing. */
function at(o: mupdf.PDFObject, ...path: (string | number)[]): mupdf.PDFObject {
  let cur = o;
  for (const k of path) {
    if (!(cur.isDictionary() || cur.isArray())) return mupdf.PDFObject.Null;
    cur = cur.get(k as string);
  }
  return cur;
}

const str = (o: mupdf.PDFObject) => (o.isString() ? o.asString() : "");
const name = (o: mupdf.PDFObject) => (o.isName() ? o.asName() : "");

export function checkAccessibility(pdf: mupdf.PDFDocument, opts: { fileName: string; lang: string }): A11yReport {
  const checks: A11yCheck[] = [];
  const root = pdf.getTrailer().get("Root");
  const info = pdf.getTrailer().get("Info");
  const pages = pdf.countPages();

  // Tags and structure
  const marked = at(root, "MarkInfo", "Marked");
  const tagged = marked.isBoolean() && marked.asBoolean() && root.get("StructTreeRoot").isDictionary();
  checks.push(
    tagged
      ? { id: "tagged", label: "Tagged for screen readers", status: "pass" }
      : { id: "tagged", label: "Tagged for screen readers", status: "fail", detail: "Without tags, screen readers guess the reading order and can't tell headings, lists or tables apart. Export a tagged PDF from the original application (in Word: Save as PDF with \"Document structure tags\")." },
  );

  // Language
  const lang = str(root.get("Lang"));
  checks.push(lang ? { id: "language", label: "Document language set", status: "pass", detail: lang } : { id: "language", label: "Document language set", status: "fail", detail: "Screen readers need it to pick the right voice and pronunciation.", fix: "language" });

  // Title
  const title = str(at(info, "Title")).trim();
  const display = at(root, "ViewerPreferences", "DisplayDocTitle");
  const showsTitle = display.isBoolean() && display.asBoolean();
  checks.push(
    title && showsTitle
      ? { id: "title", label: "Title set and shown in the title bar", status: "pass", detail: title }
      : { id: "title", label: "Title set and shown in the title bar", status: "fail", detail: title ? "The title exists but apps are told to show the file name instead." : "The document has no title.", fix: "title" },
  );

  // Text
  const textless: number[] = [];
  let unmapped = 0;
  for (let p = 0; p < pages; p++) {
    const page = pdf.loadPage(p);
    const st = page.toStructuredText("");
    const t = st.asText();
    st.destroy();
    page.destroy();
    if (t.replace(/\s+/g, "").length < 10) textless.push(p);
    unmapped += (t.match(/�/g) ?? []).length;
  }
  if (textless.length === pages && pages > 0) checks.push({ id: "text", label: "Pages have real text", status: "fail", detail: "No page has text: this looks like a scan. Recognise text first (Protect → Recognise text).", fix: "ocr" });
  else if (textless.length) checks.push({ id: "text", label: "Pages have real text", status: "warn", detail: `${textless.length} page${textless.length === 1 ? " has" : "s have"} no text (${list(textless)}). If they are scans, recognise their text.`, fix: "ocr" });
  else checks.push({ id: "text", label: "Pages have real text", status: "pass" });
  checks.push(
    unmapped
      ? { id: "unicode", label: "Text can be read out", status: "fail", detail: `${unmapped} character${unmapped === 1 ? "" : "s"} use fonts without a Unicode mapping, so screen readers can't read them.` }
      : { id: "unicode", label: "Text can be read out", status: "pass" },
  );

  // Structure tree contents
  const figures: Figure[] = [];
  let headings = 0;
  if (tagged) {
    walkStruct(pdf, root.get("StructTreeRoot"), (el, num) => {
      const s = name(el.get("S"));
      if (/^H[1-6]?$/.test(s)) headings++;
      if (s === "Figure") {
        const pg = el.get("Pg");
        figures.push({ id: num, page: pg.isDictionary() ? pageIndexOf(pdf, pg) : null, alt: str(el.get("Alt")) || str(el.get("ActualText")) });
      }
    });
    const missing = figures.filter((f) => !f.alt).length;
    checks.push(
      !figures.length
        ? { id: "alt", label: "Images have alternative text", status: "pass", detail: "No tagged images." }
        : missing
          ? { id: "alt", label: "Images have alternative text", status: "fail", detail: `${missing} of ${figures.length} image${figures.length === 1 ? "" : "s"} have no description.`, fix: "altText" }
          : { id: "alt", label: "Images have alternative text", status: "pass" },
    );
    checks.push(
      headings
        ? { id: "headings", label: "Headings are tagged", status: "pass", detail: `${headings} heading${headings === 1 ? "" : "s"}.` }
        : { id: "headings", label: "Headings are tagged", status: "warn", detail: "No heading tags, so people can't jump between sections." },
    );
    checks.push({ id: "order", label: "Reading order", status: "manual", detail: "Follows the tags. Check it with a screen reader for complex layouts (columns, sidebars)." });
  } else {
    checks.push({ id: "alt", label: "Images have alternative text", status: "manual", detail: "Can't be checked without tags." });
  }

  // Annotations: tab order, link descriptions, field tooltips
  let noTabs = 0;
  let links = 0;
  let linksNoText = 0;
  for (let p = 0; p < pages; p++) {
    const page = pdf.loadPage(p);
    const obj = page.getObject();
    const annots = obj.get("Annots");
    if (annots.isArray() && annots.length > 0) {
      if (name(obj.get("Tabs")) !== "S") noTabs++;
      for (let i = 0; i < annots.length; i++) {
        const a = annots.get(i);
        if (name(a.get("Subtype")) === "Link") {
          links++;
          if (!str(a.get("Contents"))) linksNoText++;
        }
      }
    }
    page.destroy();
  }
  checks.push(noTabs ? { id: "tabs", label: "Tab order follows the structure", status: "fail", detail: `${noTabs} page${noTabs === 1 ? "" : "s"} with links or fields don't say so.`, fix: "tabOrder" } : { id: "tabs", label: "Tab order follows the structure", status: "pass" });
  if (links) checks.push(linksNoText ? { id: "links", label: "Links are described", status: "warn", detail: `${linksNoText} of ${links} link${links === 1 ? "" : "s"} have no description.`, fix: "linkText" } : { id: "links", label: "Links are described", status: "pass" });

  const fields = formFields(pdf);
  if (fields.length) {
    const noTip = fields.filter((f) => !str(f.get("TU"))).length;
    checks.push(noTip ? { id: "fields", label: "Form fields have descriptions", status: "fail", detail: `${noTip} of ${fields.length} field${fields.length === 1 ? "" : "s"} have no tooltip, so screen readers only announce their type.`, fix: "tooltips" } : { id: "fields", label: "Form fields have descriptions", status: "pass" });
  }

  // Navigation
  const outline = at(root, "Outlines", "First");
  if (pages > 20) {
    checks.push(outline.isDictionary() ? { id: "bookmarks", label: "Bookmarks for long documents", status: "pass" } : { id: "bookmarks", label: "Bookmarks for long documents", status: "warn", detail: `${pages} pages and no bookmarks.`, fix: "bookmarks" });
  }

  // Security mustn't block assistive technology
  const encrypted = pdf.getMetaData("encryption");
  if (encrypted && encrypted !== "None" && !pdf.hasPermission("accessibility") && !pdf.hasPermission("copy")) {
    checks.push({ id: "security", label: "Security allows screen readers", status: "fail", detail: "The file's permissions block text access for assistive technology." });
  }

  checks.push({ id: "contrast", label: "Colour contrast", status: "manual", detail: "Check that text stands out from its background, and that colour isn't the only way information is shown." });

  const firstHeading = (() => {
    try {
      const h = documentModel(pdf, { images: false, pages: [0] }).find((b) => b.kind === "heading");
      return h && h.kind === "heading" ? h.runs.map((r) => r.text).join("").trim() : "";
    } catch {
      return "";
    }
  })();
  return {
    checks,
    figures,
    suggested: { language: lang || opts.lang, title: title || firstHeading || opts.fileName.replace(/\.pdf$/i, "") },
  };
}

export function applyAccessibilityFixes(pdf: mupdf.PDFDocument, fixes: A11yFixes, setOutline: (nodes: OutlineEdit[]) => void): string[] {
  const done: string[] = [];
  const root = pdf.getTrailer().get("Root");
  if (fixes.language) {
    root.put("Lang", pdf.newString(fixes.language));
    done.push("language");
  }
  if (fixes.title !== undefined && fixes.title.trim()) {
    let info = pdf.getTrailer().get("Info");
    if (!info.isDictionary()) {
      info = pdf.addObject(pdf.newDictionary());
      pdf.getTrailer().put("Info", info);
    }
    info.put("Title", pdf.newString(fixes.title.trim()));
    let vp = root.get("ViewerPreferences");
    if (!vp.isDictionary()) {
      vp = pdf.newDictionary();
      root.put("ViewerPreferences", vp);
    }
    vp.put("DisplayDocTitle", true);
    done.push("title");
  }
  if (fixes.tabOrder) {
    for (let p = 0; p < pdf.countPages(); p++) {
      const page = pdf.loadPage(p);
      const obj = page.getObject();
      if (obj.get("Annots").isArray()) obj.put("Tabs", pdf.newName("S"));
      page.destroy();
    }
    done.push("tab order");
  }
  if (fixes.tooltips) {
    for (const f of formFields(pdf)) {
      if (str(f.get("TU"))) continue;
      const label = humanize(str(f.get("T")));
      if (label) f.put("TU", pdf.newString(label));
    }
    done.push("field descriptions");
  }
  if (fixes.linkText) {
    for (let p = 0; p < pdf.countPages(); p++) {
      const page = pdf.loadPage(p);
      const annots = page.getObject().get("Annots");
      if (annots.isArray()) {
        for (let i = 0; i < annots.length; i++) {
          const a = annots.get(i);
          if (name(a.get("Subtype")) !== "Link" || str(a.get("Contents"))) continue;
          const uri = str(at(a, "A", "URI"));
          const text = uri ? (uri.startsWith("mailto:") ? `Email ${uri.slice(7)}` : `Link to ${uri}`) : "Link within this document";
          a.put("Contents", pdf.newString(text));
        }
      }
      page.destroy();
    }
    done.push("link descriptions");
  }
  if (fixes.bookmarks) {
    const nodes = headingOutline(pdf);
    if (nodes.length) {
      setOutline(nodes);
      done.push("bookmarks");
    }
  }
  if (fixes.alt?.length) {
    for (const { id, text } of fixes.alt) {
      const el = pdf.newIndirect(id);
      if (el.resolve().isDictionary() && text.trim()) el.put("Alt", pdf.newString(text.trim()));
    }
    done.push("alternative text");
  }
  return done;
}

/** Bookmarks from the headings PDForge infers from the layout (level 1 → top level, 2–3 nested). */
export function headingOutline(pdf: mupdf.PDFDocument): OutlineEdit[] {
  const blocks = documentModel(pdf, { images: false });
  const out: OutlineEdit[] = [];
  let page = 0;
  let parent: OutlineEdit | null = null;
  for (const b of blocks) {
    if (b.kind === "page-break") page++;
    if (b.kind !== "heading") continue;
    const title = b.runs.map((r) => r.text).join("").trim().slice(0, 120);
    if (!title) continue;
    const node: OutlineEdit = { title, page, children: [] };
    if (b.level === 1 || !parent) {
      out.push(node);
      parent = node;
    } else parent.children.push(node);
  }
  return out;
}

function walkStruct(pdf: mupdf.PDFDocument, node: mupdf.PDFObject, fn: (el: mupdf.PDFObject, num: number) => void, depth = 0, seen = new Set<number>()) {
  if (depth > 200) return;
  const kids = node.get("K");
  const visit = (k: mupdf.PDFObject) => {
    if (!k.isDictionary()) return;
    if (k.isIndirect()) {
      const n = k.asIndirect();
      if (seen.has(n)) return;
      seen.add(n);
      if (!name(k.get("S"))) return walkStruct(pdf, k, fn, depth + 1, seen);
      fn(k, n);
    }
    walkStruct(pdf, k, fn, depth + 1, seen);
  };
  if (kids.isArray()) for (let i = 0; i < kids.length; i++) visit(kids.get(i));
  else visit(kids);
}

function pageIndexOf(pdf: mupdf.PDFDocument, pg: mupdf.PDFObject): number | null {
  if (!pg.isIndirect()) return null;
  const n = pg.asIndirect();
  for (let p = 0; p < pdf.countPages(); p++) if (pdf.findPage(p).asIndirect() === n) return p;
  return null;
}

/** Terminal form fields (the ones that carry values and tooltips). */
function formFields(pdf: mupdf.PDFDocument): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = [];
  const fields = at(pdf.getTrailer(), "Root", "AcroForm", "Fields");
  const walk = (arr: mupdf.PDFObject, depth: number) => {
    if (!arr.isArray() || depth > 32) return;
    for (let i = 0; i < arr.length; i++) {
      const f = arr.get(i);
      const kids = f.get("Kids");
      const namedKids = kids.isArray() && Array.from({ length: kids.length }, (_, j) => kids.get(j)).some((k) => k.get("T").isString());
      if (namedKids) walk(kids, depth + 1);
      else out.push(f);
    }
  };
  walk(fields, 0);
  return out;
}

/** "first_name" / "FirstName" / "txtFirstName" → "First name". */
export function humanize(fieldName: string): string {
  const last = fieldName.split(".").pop() ?? fieldName;
  const words = last
    .replace(/^(txt|tb|fld|chk|cb|rb|btn)(?=[A-Z_])/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

function list(pages: number[]): string {
  const shown = pages.slice(0, 8).map((p) => p + 1).join(", ");
  return pages.length > 8 ? `pages ${shown}, …` : `page${pages.length === 1 ? "" : "s"} ${shown}`;
}
