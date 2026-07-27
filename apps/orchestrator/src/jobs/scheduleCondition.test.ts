import { describe, expect, it } from "vitest";
import { evaluateCondition, parseCondition } from "./scheduleCondition.js";

describe("parseCondition", () => {
  it('parsea "dias_sin_respuesta >= 5"', () => {
    expect(parseCondition("dias_sin_respuesta >= 5")).toEqual({
      field: "dias_sin_respuesta",
      operator: ">=",
      value: 5,
    });
  });

  it("acepta distintos operadores", () => {
    expect(parseCondition("x > 1").operator).toBe(">");
    expect(parseCondition("x <= 2").operator).toBe("<=");
    expect(parseCondition("x < 3").operator).toBe("<");
    expect(parseCondition("x == 4").operator).toBe("==");
  });

  it("tira un error legible ante un formato inesperado", () => {
    expect(() => parseCondition("cualquier cosa")).toThrow(/formato inesperado/);
    expect(() => parseCondition("")).toThrow(/formato inesperado/);
  });
});

describe("evaluateCondition", () => {
  it(">= es inclusivo", () => {
    const c = parseCondition("dias_sin_respuesta >= 5");
    expect(evaluateCondition(c, 5)).toBe(true);
    expect(evaluateCondition(c, 4)).toBe(false);
    expect(evaluateCondition(c, 30)).toBe(true);
  });

  it("< es exclusivo", () => {
    const c = parseCondition("x < 10");
    expect(evaluateCondition(c, 9)).toBe(true);
    expect(evaluateCondition(c, 10)).toBe(false);
  });
});
