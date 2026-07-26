import { describe, expect, it, vi } from "vitest";
import type { Intent, Property } from "shared-types";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { ResponseComposer } from "./composer.js";
import { runConsultaDisponibilidad } from "./consultaDisponibilidad.js";

const intent: Intent = {
  id: "consulta_disponibilidad",
  description: "El cliente pregunta si una propiedad sigue disponible.",
  channel: "cliente",
  priority: "high",
  triggers: { examples: ["¿el depto de Palermo sigue disponible?"] },
  tools: ["tokko.search_properties", "tokko.get_property"],
  requires_client_confirmation: false,
  requires_broker: false,
  confidence_threshold: 0.7,
  response: {
    style: "generative_grounded",
    grounding_fields: ["estado", "direccion", "tipo", "precio"],
    fallback_if_not_found: "No encontré esa propiedad con esos datos, ¿me pasás la dirección?",
  },
};

const property: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
  precio: 350000,
};

function stubComposer(fn: ResponseComposer["compose"] = vi.fn(async () => "respuesta")): ResponseComposer {
  return { compose: fn };
}

describe("runConsultaDisponibilidad", () => {
  it("busca, trae la ficha, y compone la respuesta solo con los grounding_fields del intent", async () => {
    const searchProperties = vi.fn(async () => [property]);
    const getProperty = vi.fn(async () => property);
    const tokko: TokkoQueries = { searchProperties, getProperty };
    const compose = vi.fn(async () => "Sí, el depto de Palermo sigue disponible por $350.000.");
    const composer = stubComposer(compose);

    const result = await runConsultaDisponibilidad(
      { intentId: "consulta_disponibilidad", confidence: 0.9, searchQuery: "Palermo" },
      intent,
      tokko,
      composer,
      "es-AR"
    );

    expect(searchProperties).toHaveBeenCalledWith({ direccion: "Palermo" });
    expect(getProperty).toHaveBeenCalledWith("prop-1");
    expect(compose).toHaveBeenCalledWith({
      intentDescription: intent.description,
      groundingData: { estado: "disponible", direccion: property.direccion, tipo: "departamento", precio: 350000 },
      language: "es-AR",
    });
    expect(result).toEqual({
      responseText: "Sí, el depto de Palermo sigue disponible por $350.000.",
      toolsCalled: ["tokko.search_properties", "tokko.get_property"],
    });
  });

  it("usa el fallback_if_not_found sin llamar al composer si no hay matches (nunca inventa)", async () => {
    const tokko: TokkoQueries = {
      searchProperties: vi.fn(async () => []),
      getProperty: vi.fn(async () => property),
    };
    const compose = vi.fn(async () => "no debería llamarse");
    const composer = stubComposer(compose);

    const result = await runConsultaDisponibilidad(
      { intentId: "consulta_disponibilidad", confidence: 0.9, searchQuery: "Nordelta" },
      intent,
      tokko,
      composer,
      "es-AR"
    );

    expect(compose).not.toHaveBeenCalled();
    expect(result.responseText).toBe(intent.response.fallback_if_not_found);
    expect(result.toolsCalled).toEqual(["tokko.search_properties"]);
  });
});
