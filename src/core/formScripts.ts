// A safe interpreter for the small part of Acrobat form JavaScript that real forms rely on.
// Nothing here evaluates document code: scripts are pattern-matched or parsed into a tiny
// arithmetic AST. Anything else is reported as unsupported and left alone.

export type FieldFormat =
  | { kind: "number"; decimals: number; sepStyle: number; negStyle: number; currency: string; prepend: boolean }
  | { kind: "percent"; decimals: number; sepStyle: number }
  | { kind: "date"; pattern: string }
  | { kind: "time"; style: number }
  | { kind: "special"; style: number };

export type Calculation =
  | { kind: "aggregate"; op: "SUM" | "AVG" | "PRD" | "MIN" | "MAX"; fields: string[] }
  | { kind: "expr"; statements: Stmt[] };

type Expr =
  | { t: "num"; v: number }
  | { t: "field"; name: string }
  | { t: "var"; name: string }
  | { t: "neg"; e: Expr }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; a: Expr; b: Expr }
  | { t: "call"; fn: string; args: Expr[] };
type Stmt = { t: "let"; name: string; e: Expr } | { t: "result"; e: Expr };

const DATE_FORMATS = ["m/d", "m/d/yy", "mm/dd/yy", "mm/yy", "d-mmm", "d-mmm-yy", "dd-mmm-yy", "yy-mm-dd", "mmm-yy", "mmmm-yy", "mmm d, yyyy", "mmmm d, yyyy", "m/d/yy h:MM tt", "m/d/yy HH:MM"];

function args(js: string, fn: string): string[] | null {
  const m = new RegExp(`${fn}\\s*\\(([^)]*)\\)`).exec(js);
  if (!m) return null;
  return m[1].split(",").map((a) => a.trim().replace(/^["']|["']$/g, ""));
}

export function parseFormat(js: string | null | undefined): FieldFormat | null {
  if (!js) return null;
  let a: string[] | null;
  if ((a = args(js, "AFNumber_Format"))) {
    return {
      kind: "number",
      decimals: Number(a[0]) || 0,
      sepStyle: Number(a[1]) || 0,
      negStyle: Number(a[2]) || 0,
      currency: a[4] ?? "",
      prepend: a[5] === "true",
    };
  }
  if ((a = args(js, "AFPercent_Format"))) return { kind: "percent", decimals: Number(a[0]) || 0, sepStyle: Number(a[1]) || 0 };
  if ((a = args(js, "AFDate_FormatEx"))) return { kind: "date", pattern: a[0] || "mm/dd/yyyy" };
  if ((a = args(js, "AFDate_Format"))) return { kind: "date", pattern: DATE_FORMATS[Number(a[0])] ?? "mm/dd/yyyy" };
  if ((a = args(js, "AFTime_Format"))) return { kind: "time", style: Number(a[0]) || 0 };
  if ((a = args(js, "AFSpecial_Format"))) return { kind: "special", style: Number(a[0]) || 0 };
  return null;
}

/** Acrobat's AFMakeNumber: tolerant parsing of "1,234.50", "$12", "(5)" etc. */
export function makeNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  const negParen = /^\(.*\)$/.test(s);
  s = s.replace(/[^\d.,\-eE+]/g, "");
  // "1.234,5" (comma decimal) vs "1,234.5": the last separator is the decimal point.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n) || s === "" || s === "-") return null;
  return negParen ? -Math.abs(n) : n;
}

function groupDigits(int: string, sep: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

export function formatValue(fmt: FieldFormat | null, raw: string): string {
  if (!fmt || raw === "") return raw;
  switch (fmt.kind) {
    case "number":
    case "percent": {
      let n = makeNumber(raw);
      if (n === null) return raw;
      if (fmt.kind === "percent") n *= 100;
      const neg = n < 0;
      const fixed = Math.abs(n).toFixed(fmt.decimals);
      const [int, frac] = fixed.split(".");
      // sepStyle: 0 = 1,234.56  1 = 1234.56  2 = 1.234,56  3 = 1234,56  4 = 1'234.56
      const [thousands, decimal] = [[",", "."], ["", "."], [".", ","], ["", ","], ["'", "."]][fmt.sepStyle] ?? [",", "."];
      let s = groupDigits(int, thousands) + (frac ? decimal + frac : "");
      if (fmt.kind === "percent") return (neg ? "-" : "") + s + "%";
      if (fmt.currency) s = fmt.prepend ? fmt.currency + s : s + fmt.currency;
      // negStyle: 0 = -x, 1 = x (red), 2 = (x), 3 = (x) red. Colour isn't expressible in a value.
      if (neg) s = fmt.negStyle >= 2 ? `(${s})` : fmt.negStyle === 1 ? s : `-${s}`;
      return s;
    }
    case "date": {
      const d = parseDate(raw, fmt.pattern);
      return d ? formatDate(d, fmt.pattern) : raw;
    }
    case "special": {
      const digits = raw.replace(/\D/g, "");
      if (fmt.style === 0) return digits.slice(0, 5);
      if (fmt.style === 1) return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5, 9)}` : digits;
      if (fmt.style === 2) return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits.length === 7 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : raw;
      if (fmt.style === 3) return digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : raw;
      return raw;
    }
    case "time":
      return raw;
  }
}

/** Whether a typed value is acceptable for the field's format (Acrobat's keystroke check). */
export function isAcceptable(fmt: FieldFormat | null, value: string): boolean {
  if (!fmt || value === "") return true;
  if (fmt.kind === "number" || fmt.kind === "percent") return makeNumber(value) !== null;
  if (fmt.kind === "date") return parseDate(value, fmt.pattern) !== null;
  return true;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function formatDate(d: Date, pattern: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return pattern.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d|HH|H|hh|h|MM|M|tt/g, (tok) => {
    switch (tok) {
      case "yyyy": return String(d.getFullYear());
      case "yy": return pad(d.getFullYear() % 100);
      case "mmmm": return MONTHS[d.getMonth()];
      case "mmm": return MONTHS[d.getMonth()].slice(0, 3);
      case "mm": return pad(d.getMonth() + 1);
      case "m": return String(d.getMonth() + 1);
      case "dd": return pad(d.getDate());
      case "d": return String(d.getDate());
      case "HH": return pad(d.getHours());
      case "H": return String(d.getHours());
      case "hh": return pad(d.getHours() % 12 || 12);
      case "h": return String(d.getHours() % 12 || 12);
      case "MM": return pad(d.getMinutes());
      case "M": return String(d.getMinutes());
      case "tt": return d.getHours() < 12 ? "am" : "pm";
      default: return tok;
    }
  });
}

/** Parses a date typed in the field's pattern, or ISO (from a date picker). */
export function parseDate(value: string, pattern: string): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (iso) return valid(+iso[1], +iso[2], +iso[3]);
  const nums = value.match(/\d+/g)?.map(Number) ?? [];
  const monthName = MONTHS.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}`, "i").test(value));
  const order = (pattern.match(/y+|m+|d+/g) ?? ["m", "d", "y"]).map((t) => t[0]).filter((c, i, a) => a.indexOf(c) === i);
  let y: number | undefined, m: number | undefined, d: number | undefined;
  let k = 0;
  for (const part of order) {
    if (part === "m" && monthName >= 0) {
      m = monthName + 1;
      continue;
    }
    const n = nums[k++];
    if (n === undefined) break;
    if (part === "y") y = n;
    else if (part === "m") m = n;
    else d = n;
  }
  if (y === undefined) y = new Date().getFullYear();
  if (y < 100) y += y < 50 ? 2000 : 1900;
  if (m === undefined || d === undefined) return null;
  return valid(y, m, d);
}

function valid(y: number, m: number, d: number): Date | null {
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

export function parseCalculation(js: string | null | undefined): Calculation | null {
  if (!js) return null;
  const agg = /AFSimple_Calculate\s*\(\s*["'](SUM|AVG|PRD|MIN|MAX)["']\s*,\s*(?:new\s+Array\s*\(([^)]*)\)|\[([^\]]*)\]|["']([^"']*)["'])\s*\)/.exec(js);
  if (agg) {
    const list = agg[2] ?? agg[3] ?? agg[4] ?? "";
    const fields = [...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    return { kind: "aggregate", op: agg[1] as "SUM", fields: fields.length ? fields : list.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  // Simplified field notation, stored by Acrobat between BVCALC and EVCALC.
  const sfn = /BVCALC\s+([\s\S]*?)\s+EVCALC/.exec(js);
  if (sfn) {
    try {
      return { kind: "expr", statements: [{ t: "result", e: new Parser(sfn[1], true).expr() }] };
    } catch {
      return null;
    }
  }
  try {
    return { kind: "expr", statements: new Parser(js, false).program() };
  } catch {
    return null;
  }
}

export function evaluate(calc: Calculation, value: (field: string) => string | number | null): number | null {
  const num = (name: string) => makeNumber(value(name)) ?? 0;
  if (calc.kind === "aggregate") {
    const xs = calc.fields.map(num);
    if (!xs.length) return 0;
    switch (calc.op) {
      case "SUM": return xs.reduce((a, b) => a + b, 0);
      case "PRD": return xs.reduce((a, b) => a * b, 1);
      case "AVG": return xs.reduce((a, b) => a + b, 0) / xs.length;
      case "MIN": return Math.min(...xs);
      case "MAX": return Math.max(...xs);
    }
  }
  const vars = new Map<string, number>();
  const ev = (e: Expr): number => {
    switch (e.t) {
      case "num": return e.v;
      case "field": return num(e.name);
      case "var": {
        if (!vars.has(e.name)) throw new Error(`unknown variable ${e.name}`);
        return vars.get(e.name)!;
      }
      case "neg": return -ev(e.e);
      case "bin": {
        const a = ev(e.a);
        const b = ev(e.b);
        return e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "*" ? a * b : b === 0 ? 0 : a / b;
      }
      case "call": {
        const xs = e.args.map(ev);
        const fns: Record<string, (...a: number[]) => number> = {
          round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs, min: Math.min, max: Math.max, number: (x) => x,
        };
        return fns[e.fn](...xs);
      }
    }
  };
  let result: number | null = null;
  try {
    for (const s of calc.statements) {
      if (s.t === "let") vars.set(s.name, ev(s.e));
      else result = ev(s.e);
    }
  } catch {
    return null;
  }
  return result === null || !Number.isFinite(result) ? null : result;
}

/**
 * Recursive-descent parser for:  [var x = EXPR;]*  event.value = EXPR;
 * EXPR: numbers, + - * / ( ), getField("name").value (optionally this./AFMakeNumber(...)/Number(...)),
 * and Math.round/floor/ceil/abs/min/max. In simplified field notation, bare identifiers are field names.
 */
class Parser {
  private i = 0;
  constructor(private src: string, private bareFields: boolean) {
    this.src = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  program(): Stmt[] {
    const out: Stmt[] = [];
    let sawResult = false;
    while (this.skip(), this.i < this.src.length) {
      if (this.eat("var") || this.eat("let") || this.eat("const")) {
        const name = this.ident();
        this.expect("=");
        out.push({ t: "let", name, e: this.expr() });
      } else if (this.eat("event.value")) {
        this.expect("=");
        out.push({ t: "result", e: this.expr() });
        sawResult = true;
      } else throw new Error("unsupported statement");
      this.skip();
      this.eat(";");
    }
    if (!sawResult) throw new Error("no result");
    return out;
  }

  expr(): Expr {
    let a = this.term();
    for (;;) {
      if (this.eat("+")) a = { t: "bin", op: "+", a, b: this.term() };
      else if (this.eat("-")) a = { t: "bin", op: "-", a, b: this.term() };
      else return a;
    }
  }

  private term(): Expr {
    let a = this.unary();
    for (;;) {
      if (this.eat("*")) a = { t: "bin", op: "*", a, b: this.unary() };
      else if (this.eat("/")) a = { t: "bin", op: "/", a, b: this.unary() };
      else return a;
    }
  }

  private unary(): Expr {
    if (this.eat("-")) return { t: "neg", e: this.unary() };
    if (this.eat("+")) return this.unary();
    return this.atom();
  }

  private atom(): Expr {
    this.skip();
    if (this.eat("(")) {
      const e = this.expr();
      this.expect(")");
      return e;
    }
    const num = /^\d+(\.\d+)?|^\.\d+/.exec(this.src.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return { t: "num", v: Number(num[0]) };
    }
    this.eat("this.");
    if (this.eat("getField")) {
      this.expect("(");
      const name = this.string();
      this.expect(")");
      this.expect(".value");
      return { t: "field", name };
    }
    for (const wrap of ["AFMakeNumber", "Number", "parseFloat"]) {
      if (this.eat(wrap)) {
        this.expect("(");
        const e = this.expr();
        this.expect(")");
        return e;
      }
    }
    const math = /^Math\.(round|floor|ceil|abs|min|max)\s*\(/.exec(this.src.slice(this.i));
    if (math) {
      this.i += math[0].length;
      const list: Expr[] = [this.expr()];
      while (this.eat(",")) list.push(this.expr());
      this.expect(")");
      return { t: "call", fn: math[1], args: list };
    }
    if (this.bareFields) {
      // Field names in simplified notation may contain dots; backslash escapes other characters.
      const m = /^(?:\\.|[A-Za-z0-9_.])+/.exec(this.src.slice(this.i));
      if (m) {
        this.i += m[0].length;
        return { t: "field", name: m[0].replace(/\\(.)/g, "$1") };
      }
    }
    return { t: "var", name: this.ident() };
  }

  private ident(): string {
    this.skip();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i));
    if (!m) throw new Error("expected a name");
    this.i += m[0].length;
    return m[0];
  }

  private string(): string {
    this.skip();
    const m = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/.exec(this.src.slice(this.i));
    if (!m) throw new Error("expected a string");
    this.i += m[0].length;
    return (m[1] ?? m[2]).replace(/\\(.)/g, "$1");
  }

  private skip() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  private eat(tok: string): boolean {
    this.skip();
    if (this.src.startsWith(tok, this.i)) {
      // Don't let "var" match the start of "variable".
      if (/^[A-Za-z]/.test(tok) && /[\w$]/.test(this.src[this.i + tok.length] ?? "") && !tok.endsWith(".")) return false;
      this.i += tok.length;
      return true;
    }
    return false;
  }

  private expect(tok: string) {
    if (!this.eat(tok)) throw new Error(`expected ${tok}`);
  }
}
