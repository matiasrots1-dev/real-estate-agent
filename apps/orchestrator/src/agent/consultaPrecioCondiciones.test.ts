import { describe, expect, it, vi } from "vitest";
import type { Intent, Property } from "shared-types";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { ResponseComposer } from "./composer.js";
import { runConsultaPrecioCondiciones } from "./consultaPrecioCondiciones.js";

const intent: Intent = {
  id: "consulta_precio_condiciones",
  description: "Precio, expensas, requisitos, garantías, forma de pago publicados.",
  channel: "cliente",
  priority: "high",
  triggers: { examples: ["¿cuánto sale el alquiler?"] },
  tools: ["tokko.get_property"],
  requires_client_confirmation: false,
  requires_broker: false,
  confidence_threshold: 0.75,
  response: {
    style: "generative_grounded",
    grounding_fields: ["precio", "expensas", "requisitos", "garantiasAceptadas"],
    fallback_if_missing_field: "Ese dato no lo tengo cargado, te confirmo en breve.",
  },
};

function stubComposer(fn: ResponseComposer["compose"] = vi.fn(async () => "respuesta")): ResponseComposer {
  return { compose: fn };
}

describe("runConsultaPrecioCondiciones", () => {
  it("compone la respuesta con precio/expensas/requisitos/garantías cuando están cargados", async () => {
    const property: Property = {
      id: "prop-1",
      tokkoId: "tokko-1001",
      direccion: "Av. Santa Fe 3253, Palermo, CABA",
      direccionCorta: "Depto Palermo",
      tipo: "departamento",
      estado: "disponible",
      precio: 350000,
      expensas: 45000,
      requisitos: "Garantía propietaria",
      garantiasAceptadas: ["propietaria"],
    };
    const tokko: TokkoQueries = {
      searchProperties: vi.fn(async () => [property]),
      getProperty: vi.fn(async () => property),
    };
    const compose = vi.fn(async () => "Sale $350.000 + $45.000 de expensas.");
    const composer = stubComposer(compose);

    const result = await runConsultaPrecioCondiciones(
      { intentId: "consulta_precio_condiciones", confidence: 0.9, searchQuery: "Palermo" },
      intent,
      tokko,
      composer,
      "es-AR"
    );

    expect(compose).toHaveBeenCalledWith({
      intentDescription: intent.description,
      groundingData: {
        precio: 350000,
        expensas: 45000,
        requisitos: "Garantía propietaria",
        garantiasAceptadas: ["propietaria"],
        _nota_si_falta_un_dato: intent.response.fallback_if_missing_field,
      },
      language: "es-AR",
    });
    expect(result.responseText).toBe("Sale $350.000 + $45.000 de expensas.");
  });

  it("pasa null explícito (no inventa) para un campo que Tokko no tiene cargado", async () => {
    const property: Property = {
      id: "prop-2",
      tokkoId: "tokko-1002",
      direccion: "Av. Cabildo 2100, Belgrano, CABA",
      direccionCorta: "2 amb. Av. Cabildo",
      tipo: "departamento",
      estado: "reservada",
      precio: 280000,
      // expensas, requisitos y garantiasAceptadas no cargados
    };
    const tokko: TokkoQueries = {
      searchProperties: vi.fn(async () => [property]),
      getProperty: vi.fn(async () => property),
    };
    const compose = vi.fn(async () => "respuesta");
    const composer = stubComposer(compose);

    await runConsultaPrecioCondiciones(
      { intentId: "consulta_precio_condiciones", confidence: 0.9, searchQuery: "Cabildo" },
      intent,
      tokko,
      composer,
      "es-AR"
    );

    const [{ groundingData }] = compose.mock.calls[0];
    expect(groundingData.expensas).toBeNull();
    expect(groundingData.requisitos).toBeNull();
    expect(groundingData.garantiasAceptadas).toBeNull();
    expect(groundingData.precio).toBe(280000);
  });

  it("usa fallback_if_not_found sin llamar al composer si no hay matches", async () => {
    const tokko: TokkoQueries = {
      searchProperties: vi.fn(async () => []),
      getProperty: vi.fn(async () => null),
    };
    const compose = vi.fn(async () => "no debería llamarse");
    const composer = stubComposer(compose);

    const result = await runConsultaPrecioCondiciones(
      { intentId: "consulta_precio_condiciones", confidence: 0.9, searchQuery: "Nordelta" },
      intent,
      tokko,
      composer,
      "es-AR"
    );

    expect(compose).not.toHaveBeenCalled();
    expect(result.toolsCalled).toEqual(["tokko.search_properties"]);
  });
});
