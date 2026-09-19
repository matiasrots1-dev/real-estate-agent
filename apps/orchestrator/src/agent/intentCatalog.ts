import {
  HUECO_DE_PLANTILLA,
  loadIntentCatalogFromFile,
  type IntentCatalog,
  type Intent,
  type IntentChannel,
} from "shared-types";

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

/**
 * La respuesta de espera genérica: la plantilla del intent que nombra
 * `meta.escalation_waiting_template_from` (docs/TASKS.md Bloque 38c). La
 * validación del catálogo garantiza que existe y no tiene huecos.
 */
export function plantillaDeEspera(catalog: IntentCatalog): string {
  const id = catalog.meta.escalation_waiting_template_from;
  const plantilla = findIntent(catalog, id)?.response.template;
  if (!plantilla) throw new Error(`El catálogo no tiene la plantilla de espera "${id}".`);
  return plantilla;
}

/**
 * Lo que recibe el cliente cuando `intent` escala (docs/TASKS.md Bloque 38c).
 *
 * Un intent que escala siempre tiene su propia plantilla de espera ("Dejame
 * confirmar esa condición con el asesor...") y va esa. Cualquier otro —uno que
 * escala por baja confianza, o desde un flujo de visitas— va con la de espera
 * genérica: su propia plantilla es la del caso exitoso ("Listo, {accion} tu
 * visita de {direccion_corta}..."), con huecos sin llenar y afirmando algo que
 * no pasó.
 */
export function respuestaDeEspera(catalog: IntentCatalog, intent: Intent): string {
  const propia = intent.response.template;
  if (intent.requires_broker === true && propia && !HUECO_DE_PLANTILLA.test(propia)) return propia;
  return plantillaDeEspera(catalog);
}

/** Umbral efectivo: el propio del intent si lo define, si no el default global. */
export function effectiveConfidenceThreshold(catalog: IntentCatalog, intent: Intent): number {
  return intent.confidence_threshold ?? catalog.meta.default_confidence_threshold;
}
