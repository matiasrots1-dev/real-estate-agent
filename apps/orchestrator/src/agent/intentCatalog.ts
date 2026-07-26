import { loadIntentCatalogFromFile, type IntentCatalog, type Intent } from "shared-types";

export function loadCatalog(intentCatalogPath: string): IntentCatalog {
  return loadIntentCatalogFromFile(intentCatalogPath);
}

export function findIntent(catalog: IntentCatalog, intentId: string): Intent | undefined {
  return catalog.intents.find((intent) => intent.id === intentId);
}

/** Umbral efectivo: el propio del intent si lo define, si no el default global. */
export function effectiveConfidenceThreshold(catalog: IntentCatalog, intent: Intent): number {
  return intent.confidence_threshold ?? catalog.meta.default_confidence_threshold;
}
