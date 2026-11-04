import { describe, expect, it } from "vitest";
import { evaluate, formatDate, formatValue, isAcceptable, makeNumber, parseCalculation, parseDate, parseFormat } from "../../src/core/formScripts";

describe("formats", () => {
  it("recognises Acrobat format scripts", () => {
    expect(parseFormat('AFNumber_Format(2, 0, 0, 0, "$", true);')).toEqual({ kind: "number", decimals: 2, sepStyle: 0, negStyle: 0, currency: "$", prepend: true });
    expect(parseFormat('AFDate_FormatEx("dd/mm/yyyy");')).toEqual({ kind: "date", pattern: "dd/mm/yyyy" });
    expect(parseFormat("AFPercent_Format(1, 0);")?.kind).toBe("percent");
    expect(parseFormat("app.alert('hi')")).toBeNull();
  });

  it("formats numbers, currency, percent and negatives", () => {
    const money = parseFormat('AFNumber_Format(2, 0, 2, 0, "$", true);');
    expect(formatValue(money, "1234.5")).toBe("$1,234.50");
    expect(formatValue(money, "-3")).toBe("($3.00)");
    expect(formatValue(parseFormat('AFNumber_Format(1, 2, 0, 0, " €", false);'), "1234.56")).toBe("1.234,6 €");
    expect(formatValue(parseFormat("AFPercent_Format(0, 0);"), "0.256")).toBe("26%");
    expect(formatValue(money, "abc")).toBe("abc");
  });

  it("formats zip, phone and SSN", () => {
    expect(formatValue({ kind: "special", style: 1 }, "123456789")).toBe("12345-6789");
    expect(formatValue({ kind: "special", style: 2 }, "5551234567")).toBe("(555) 123-4567");
    expect(formatValue({ kind: "special", style: 3 }, "123456789")).toBe("123-45-6789");
  });

  it("parses tolerant numbers like AFMakeNumber", () => {
    expect(makeNumber("$1,234.50")).toBe(1234.5);
    expect(makeNumber("1.234,5")).toBe(1234.5);
    expect(makeNumber("(12)")).toBe(-12);
    expect(makeNumber("")).toBeNull();
    expect(makeNumber("abc")).toBeNull();
  });

  it("parses and formats dates in the field's pattern", () => {
    const d = parseDate("12/25/2026", "mm/dd/yyyy")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 11, 25]);
    expect(parseDate("25/12/26", "dd/mm/yy")!.getMonth()).toBe(11);
    expect(parseDate("2026-02-30", "mm/dd/yyyy")).toBeNull();
    expect(parseDate("3-Mar-2025", "d-mmm-yyyy")!.getMonth()).toBe(2);
    expect(formatDate(new Date(2026, 0, 5), "mmm d, yyyy")).toBe("Jan 5, 2026");
    expect(formatValue({ kind: "date", pattern: "dd.mm.yyyy" }, "2026-07-04")).toBe("04.07.2026");
    expect(isAcceptable({ kind: "date", pattern: "mm/dd/yyyy" }, "13/40/2026")).toBe(false);
  });
});

describe("calculations", () => {
  const values: Record<string, string> = { a: "2", b: "3.5", "order.qty": "4", price: "$10.00" };
  const get = (n: string) => values[n] ?? null;

  it("evaluates AFSimple_Calculate in all its spellings", () => {
    expect(evaluate(parseCalculation('AFSimple_Calculate("SUM", new Array("a", "b"));')!, get)).toBe(5.5);
    expect(evaluate(parseCalculation("AFSimple_Calculate('PRD', ['a', 'b']);")!, get)).toBe(7);
    expect(evaluate(parseCalculation('AFSimple_Calculate("MAX", "a, b");')!, get)).toBe(3.5);
    expect(evaluate(parseCalculation('AFSimple_Calculate("AVG", new Array("a", "b", "missing"));')!, get)).toBeCloseTo(5.5 / 3);
  });

  it("evaluates simplified field notation", () => {
    const js = '/** BVCALC order.qty * price + a EVCALC **/ event.value = AFMakeNumber(getField("order.qty").value) * 1;';
    expect(evaluate(parseCalculation(js)!, get)).toBe(42);
  });

  it("evaluates simple custom scripts without running them", () => {
    const js = 'var q = this.getField("order.qty").value;\nvar p = AFMakeNumber(this.getField("price").value);\nevent.value = Math.round(q * p * 1.2);';
    expect(evaluate(parseCalculation(js)!, get)).toBe(48);
    expect(evaluate(parseCalculation('event.value = (getField("a").value - 1) / 0;')!, get)).toBe(0);
  });

  it("refuses anything outside the safe subset", () => {
    expect(parseCalculation('app.launchURL("http://x");')).toBeNull();
    expect(parseCalculation('event.value = this.getField("a").value; app.alert(1);')).toBeNull();
    expect(parseCalculation('event.value = eval("1+1");')).toBeNull();
    expect(parseCalculation("")).toBeNull();
  });
});
