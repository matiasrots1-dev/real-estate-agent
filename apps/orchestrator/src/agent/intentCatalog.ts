import { loadIntentCatalogFromFile, type IntentCatalog, type Intent, type IntentChannel } from "shared-types";

export function loadCatalog(intentCatalogPath: string): IntentCatalog {
  return loadIntentCatalogFromFile(intentCatalogPath);
}

export function findIntent(catalog: IntentCatalog, intentId: string): Intent | undefined {
  return catalog.intents.find((intent) => intent.id === intentId);
}

/**
 * Solo deja pasar al classifier los intents del canal que corresponde
 * (docs/TASKS.md Bloque 8) — un mensaje de cliente nunca debe poder
 * matchear un intent `channel: broker` ni viceversa. Los `channel: any`
 * (ej. consulta_clima_visita) quedan disponibles en los dos canales.
 */
export function filterCatalogByChannel(catalog: IntentCatalog, channel: IntentChannel): IntentCatalog {
  return {
    ...catalog,
    intents: catalog.intents.filter((intent) => intent.channel === channel || intent.channel === "any"),
  };
}

/** Umbral efectivo: el propio del intent si lo define, si no el default global. */
export function effectiveConfidenceThreshold(catalog: IntentCatalog, intent: Intent): number {
  return intent.confidence_threshold ?? catalog.meta.default_confidence_threshold;
}
