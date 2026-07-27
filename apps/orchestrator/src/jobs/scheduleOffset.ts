// Parsea los `offset` de docs/intent_catalog.yaml (ej. "-24h", "-2h", "+3h")
// a milisegundos relativos al evento — negativo = antes, positivo = después.
// No hardcodeamos los offsets en TypeScript (CLAUDE.md secc. 7): el
// catálogo los define, esto solo los interpreta en runtime.

export function parseOffsetToMs(offset: string): number {
  const match = offset.match(/^([+-])(\d+)h$/);
  if (!match) {
    throw new Error(`Offset con formato inesperado en el catálogo: "${offset}" (se esperaba algo como "-24h").`);
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  return sign * hours * 60 * 60 * 1000;
}
