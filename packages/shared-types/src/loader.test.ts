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
  });
});
