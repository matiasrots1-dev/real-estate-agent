import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IntentCatalog, Lead } from "shared-types";
import { findIntent, loadCatalog } from "./intentCatalog.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { ResponseComposer } from "./composer.js";
import { runBrokerResumenLeads } from "./brokerResumenLeads.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));
const intent = findIntent(catalog, "broker_resumen_leads")!;

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    tokkoId: "tokko-lead-1",
    nombre: "Juan Pérez",
    telefonoWhatsapp: "5491100000001",
    temperatura: "tibio",
    propiedadesDeInteres: ["prop-1"],
    diasSinRespuesta: 2,
    ...overrides,
  };
}

describe("runBrokerResumenLeads", () => {
  it("busca todos los leads (un solo llamado) y los agrupa por temperatura", async () => {
    const searchLeads = vi.fn(async () => [
      lead({ id: "l1", temperatura: "tibio" }),
      lead({ id: "l2", temperatura: "frio", nombre: "María Gómez" }),
      lead({ id: "l3", temperatura: "frio", nombre: "Carlos Ruiz" }),
    ]);
    const tokko: TokkoQueries = {
      searchProperties: vi.fn(),
      getProperty: vi.fn(),
      searchLeads,
      getLead: vi.fn(),
      logActivity: vi.fn(),
    };
    const compose = vi.fn(async () => "Tenés 3 leads: 1 tibio, 2 fríos.");
    const composer: ResponseComposer = { compose };

    const result = await runBrokerResumenLeads(intent, tokko, composer, "es-AR");

    expect(searchLeads).toHaveBeenCalledTimes(1);
    expect(searchLeads).toHaveBeenCalledWith({});
    expect(compose).toHaveBeenCalledWith({
      intentDescription: intent.description,
      groundingData: {
        total: 3,
        nuevos: 0,
        tibios: 1,
        frios: 2,
        listado: [
          { nombre: "Juan Pérez", temperatura: "tibio", diasSinRespuesta: 2 },
          { nombre: "María Gómez", temperatura: "frio", diasSinRespuesta: 2 },
          { nombre: "Carlos Ruiz", temperatura: "frio", diasSinRespuesta: 2 },
        ],
      },
      language: "es-AR",
    });
    expect(result.responseText).toBe("Tenés 3 leads: 1 tibio, 2 fríos.");
    expect(result.toolsCalled).toEqual(["tokko.search_leads"]);
  });

  it("no inventa leads si Tokko no devuelve ninguno", async () => {
    const tokko: TokkoQueries = {
      searchProperties: vi.fn(),
      getProperty: vi.fn(),
      searchLeads: vi.fn(async () => []),
      getLead: vi.fn(),
      logActivity: vi.fn(),
    };
    const composer: ResponseComposer = { compose: vi.fn(async () => "No tenés leads cargados.") };

    const result = await runBrokerResumenLeads(intent, tokko, composer, "es-AR");

    expect(result.responseText).toBe("No tenés leads cargados.");
  });
});
