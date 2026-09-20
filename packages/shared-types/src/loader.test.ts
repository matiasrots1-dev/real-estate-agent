import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadIntentCatalogFromFile, parseIntentCatalog, IntentCatalogValidationError } from "./loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_CATALOG_PATH = resolve(__dirname, "../../../docs/intent_catalog.yaml");

describe("loadIntentCatalogFromFile", () => {
  it("parsea docs/intent_catalog.yaml sin errores", () => {
    const catalog = loadIntentCatalogFromFile(REAL_CATALOG_PATH);
    expect(catalog.version).toBe(1);
    expect(catalog.intents.length).toBeGreaterThan(0);
  });

  it("incluye consulta_disponibilidad con sus tools de Tokko", () => {
    const catalog = loadIntentCatalogFromFile(REAL_CATALOG_PATH);
    const intent = catalog.intents.find((i) => i.id === "consulta_disponibilidad");
    expect(intent).toBeDefined();
    expect(intent?.tools).toContain("tokko.search_properties");
    expect(intent?.requires_broker).toBe(false);
  });

  it("preserva confidence_threshold null en intents sin umbral (fallback_low_confidence)", () => {
    const catalog = loadIntentCatalogFromFile(REAL_CATALOG_PATH);
    const fallback = catalog.intents.find((i) => i.id === "fallback_low_confidence");
    expect(fallback?.confidence_threshold).toBeNull();
    expect(fallback?.requires_broker).toBe(true);
  });
});

describe("parseIntentCatalog", () => {
  it("rechaza un catalog con requires_broker inválido", () => {
    const invalidYaml = `
version: 1
meta:
  default_confidence_threshold: 0.75
  escalation_channel: broker_whatsapp
  audit_log: true
  language: es-AR
  escalation_waiting_template_from: foo
intents:
  - id: foo
    description: bar
    channel: cliente
    priority: high
    tools: []
    requires_client_confirmation: false
    requires_broker: "tal_vez"
    confidence_threshold: 0.5
    response:
      style: template
      template: "hola"
`;
    expect(() => parseIntentCatalog(invalidYaml)).toThrow(IntentCatalogValidationError);
    // Y falla por eso: sin el campo de la plantilla de espera (Bloque 38c)
    // también fallaba, y el test no probaba lo que dice.
    try {
      parseIntentCatalog(invalidYaml);
    } catch (error) {
      const issues = (error as IntentCatalogValidationError).issues;
      expect(issues.every((issue) => issue.includes("requires_broker"))).toBe(true);
    }
  });
});

// docs/TASKS.md Bloque 38c. El escalamiento depende de dos cosas del catálogo;
// si no se cumplen, el catálogo no carga, antes de mandarle algo roto a un
// cliente.
describe("parseIntentCatalog — la plantilla de espera", () => {
  /** Un catálogo mínimo válido, con una variación. */
  function catalogo({
    esperaDesde = "fallback_low_confidence",
    plantillaFallback = "Dejame confirmarlo con el asesor y te respondo enseguida.",
    plantillaReclamo = "Te contacto con el asesor.",
    marcarEspera = true,
    esperaReclamo = true,
    plantillaFicha = "Te paso el material de {direccion_corta}:",
    esperaFicha = null,
  }: {
    esperaDesde?: string;
    plantillaFallback?: string | null;
    plantillaReclamo?: string;
    marcarEspera?: boolean;
    esperaReclamo?: boolean | null;
    plantillaFicha?: string;
    esperaFicha?: boolean | null;
  } = {}): string {
    // `espera: true` lo exige el schema para la plantilla de espera genérica
    // (docs/TASKS.md Bloque 38e). La marca va aparte de la plantilla: un
    // intent marcado como frase de espera y sin plantilla también tiene que
    // fallar.
    const lineaEspera = (valor: boolean | null | undefined): string =>
      valor === null || valor === undefined ? "" : `\n      espera: ${valor}`;
    const templateFallback =
      (plantillaFallback === null ? "" : `\n      template: "${plantillaFallback}"`) +
      (marcarEspera ? "\n      espera: true" : "");
    return `
version: 1
meta:
  default_confidence_threshold: 0.75
  escalation_channel: broker_whatsapp
  audit_log: true
  language: es-AR
  escalation_waiting_template_from: ${esperaDesde}
intents:
  - id: fallback_low_confidence
    description: no se entendió
    channel: any
    priority: high
    tools: []
    requires_client_confirmation: false
    requires_broker: true
    confidence_threshold: null
    response:
      style: template${templateFallback}
  - id: reclamo_queja
    description: reclamo
    channel: cliente
    priority: high
    tools: []
    requires_client_confirmation: false
    requires_broker: true
    confidence_threshold: 0.75
    response:
      style: template
      template: "${plantillaReclamo}"${lineaEspera(esperaReclamo)}
  - id: pedido_ficha_multimedia
    description: ficha
    channel: cliente
    priority: low
    tools: []
    requires_client_confirmation: false
    requires_broker: false
    confidence_threshold: 0.75
    response:
      style: template
      template: "${plantillaFicha}"${lineaEspera(esperaFicha)}
`;
  }

  function problemas(yaml: string): string[] {
    try {
      parseIntentCatalog(yaml);
    } catch (error) {
      if (error instanceof IntentCatalogValidationError) return error.issues;
      throw error;
    }
    return [];
  }

  it("un catálogo válido carga, y una plantilla con huecos está bien en un intent que no escala solo", () => {
    expect(problemas(catalogo())).toEqual([]);
  });

  it("el catálogo real dice cuál es la plantilla de espera, y cumple todo", () => {
    const real = loadIntentCatalogFromFile(REAL_CATALOG_PATH);
    expect(real.meta.escalation_waiting_template_from).toBe("fallback_low_confidence");
  });

  it("falla si el intent de espera no existe", () => {
    expect(problemas(catalogo({ esperaDesde: "no_existe" })).join("\n")).toContain('no existe ningún intent "no_existe"');
  });

  // docs/TASKS.md Bloque 38e, modo de fallo 2: sin la marca, la frase de
  // espera se repetiría como antes del Bloque 31 y nada lo mostraría.
  it("falla si la plantilla de espera genérica no está marcada como frase de espera", () => {
    // Por SU regla, no por la de abajo ("tiene que decir si es de espera"),
    // que sólo mira los intents con `requires_broker: true`: el intent al que
    // apunta `escalation_waiting_template_from` puede no serlo (revisión del
    // PR #42 — sin esto el test pasaba con la regla borrada).
    expect(problemas(catalogo({ marcarEspera: false })).join("\n")).toContain(
      "es la plantilla de espera genérica"
    );
  });

  it("falla si el intent de espera no tiene plantilla", () => {
    expect(problemas(catalogo({ plantillaFallback: null })).join("\n")).toContain("no tiene plantilla");
  });

  it("falla si la plantilla de espera tiene huecos", () => {
    const issues = problemas(catalogo({ plantillaFallback: "Dejame ver lo de {direccion_corta}." }));
    expect(issues.join("\n")).toContain("fallback_low_confidence");
  });

  it("falla si un intent que escala siempre tiene una plantilla con huecos", () => {
    const issues = problemas(catalogo({ plantillaReclamo: "Te contacto con {nombre_asesor}." }));
    expect(issues.join("\n")).toContain("reclamo_queja");
  });

  // Revisión del PR #42. Las tres reglas de abajo existen para que el intent
  // que alguien agregue mañana no quede fuera del cupo por omisión: el modo de
  // fallo del Bloque 31 vuelve en silencio, sin que ningún test lo muestre.
  it("falla si un intent que escala siempre con plantilla fija no dice si es una frase de espera", () => {
    const issues = problemas(catalogo({ esperaReclamo: null })).join("\n");
    expect(issues).toContain("reclamo_queja");
    expect(issues).toContain("tiene que decir si es una frase de espera");
  });

  it("decir que NO es una frase de espera es válido: una despedida escala y sale siempre", () => {
    expect(problemas(catalogo({ esperaReclamo: false }))).toEqual([]);
  });

  it("falla si un intent está marcado como frase de espera y no tiene plantilla", () => {
    // `frasesDeEspera` lo ignoraría en silencio: el intent quedaría fuera del
    // cupo creyendo que está adentro.
    const issues = problemas(catalogo({ plantillaFallback: null })).join("\n");
    expect(issues).toContain("está marcado como frase de espera pero no tiene plantilla");
  });

  it("falla si un intent que no escala siempre está marcado como frase de espera", () => {
    // La supresión está cableada en el cierre del escalamiento: esa frase
    // saldría sin pasar por ahí, pero gastaría igual el cupo.
    const issues = problemas(
      catalogo({ plantillaFicha: "Te paso el material.", esperaFicha: true })
    ).join("\n");
    expect(issues).toContain("pedido_ficha_multimedia");
    expect(issues).toContain("no escala siempre");
  });
});
