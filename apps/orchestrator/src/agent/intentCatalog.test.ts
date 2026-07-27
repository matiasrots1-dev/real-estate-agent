import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IntentCatalog } from "shared-types";
import { effectiveConfidenceThreshold, filterCatalogByChannel, findIntent, loadCatalog } from "./intentCatalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));

describe("filterCatalogByChannel", () => {
  it('"cliente" incluye los intents de cliente y los "any", pero no los de broker', () => {
    const filtered = filterCatalogByChannel(catalog, "cliente");
    const ids = filtered.intents.map((i) => i.id);

    expect(ids).toContain("consulta_disponibilidad"); // channel: cliente
    expect(ids).toContain("consulta_clima_visita"); // channel: any
    expect(ids).not.toContain("broker_resumen_agenda"); // channel: broker
    expect(ids).not.toContain("broker_accion_directa");
  });

  it('"broker" incluye los intents de broker y los "any", pero no los de cliente', () => {
    const filtered = filterCatalogByChannel(catalog, "broker");
    const ids = filtered.intents.map((i) => i.id);

    expect(ids).toContain("broker_resumen_agenda");
    expect(ids).toContain("broker_resumen_leads");
    expect(ids).toContain("consulta_clima_visita"); // channel: any
    expect(ids).not.toContain("consulta_disponibilidad");
    expect(ids).not.toContain("hablar_con_persona");
  });

  it("no muta el catálogo original", () => {
    const originalCount = catalog.intents.length;
    filterCatalogByChannel(catalog, "broker");
    expect(catalog.intents.length).toBe(originalCount);
  });
});

describe("findIntent / effectiveConfidenceThreshold (sanity, ya cubiertos indirectamente en otros tests)", () => {
  it("findIntent encuentra por id", () => {
    expect(findIntent(catalog, "consulta_disponibilidad")?.id).toBe("consulta_disponibilidad");
  });

  it("effectiveConfidenceThreshold usa el default global si el intent no define uno propio", () => {
    const fallback = findIntent(catalog, "fallback_low_confidence");
    expect(fallback?.confidence_threshold).toBeNull();
    expect(effectiveConfidenceThreshold(catalog, fallback!)).toBe(catalog.meta.default_confidence_threshold);
  });
});
