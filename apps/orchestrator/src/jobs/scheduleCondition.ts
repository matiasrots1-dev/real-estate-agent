// Parsea las `condition` de docs/intent_catalog.yaml (ej. "dias_sin_respuesta
// >= 5") — a diferencia de los `offset` (scheduleOffset.ts), estas condiciones
// no son relativas al tiempo sino a un campo del lead. Nunca hardcodeamos los
// umbrales (5/15/30) en TypeScript (CLAUDE.md secc. 7): el catálogo los
// define, esto solo los interpreta en runtime.

export interface ParsedCondition {
  field: string;
  operator: ">=" | ">" | "<=" | "<" | "==";
  value: number;
}

export function parseCondition(condition: string): ParsedCondition {
  const match = condition.trim().match(/^(\w+)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) {
    throw new Error(`Condición con formato inesperado en el catálogo: "${condition}".`);
  }
  return { field: match[1], operator: match[2] as ParsedCondition["operator"], value: Number(match[3]) };
}

export function evaluateCondition(condition: ParsedCondition, actualValue: number): boolean {
  switch (condition.operator) {
    case ">=":
      return actualValue >= condition.value;
    case ">":
      return actualValue > condition.value;
    case "<=":
      return actualValue <= condition.value;
    case "<":
      return actualValue < condition.value;
    case "==":
      return actualValue === condition.value;
  }
}
