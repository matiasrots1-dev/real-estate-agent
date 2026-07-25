import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { IntentCatalogSchema, type IntentCatalog } from "./schemas/intentCatalog.js";

export class IntentCatalogValidationError extends Error {
  constructor(message: string, public readonly issues: string[]) {
    super(message);
    this.name = "IntentCatalogValidationError";
  }
}

/** Parsea y valida el contenido YAML de un intent catalog contra el schema. */
export function parseIntentCatalog(yamlContent: string): IntentCatalog {
  const raw = parseYaml(yamlContent);
  const result = IntentCatalogSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );
    throw new IntentCatalogValidationError(
      "intent_catalog.yaml no cumple el schema esperado",
      issues
    );
  }
  return result.data;
}

/** Lee y valida el intent catalog desde un archivo YAML en disco. */
export function loadIntentCatalogFromFile(filePath: string): IntentCatalog {
  const yamlContent = readFileSync(filePath, "utf-8");
  return parseIntentCatalog(yamlContent);
}
