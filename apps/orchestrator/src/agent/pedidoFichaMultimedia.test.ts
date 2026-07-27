import { describe, expect, it, vi } from "vitest";
import type { Intent, Property } from "shared-types";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import { runPedidoFichaMultimedia } from "./pedidoFichaMultimedia.js";

const intent: Intent = {
  id: "pedido_ficha_multimedia",
  description: "Cliente pide fotos, planos, video o más info visual de una propiedad.",
  channel: "cliente",
  priority: "normal",
  triggers: { examples: ["mandame fotos"] },
  tools: ["tokko.get_property", "whatsapp.send_media"],
  requires_client_confirmation: false,
  requires_broker: false,
  confidence_threshold: 0.75,
  response: { style: "template", template: "Te paso el material de {direccion_corta}:" },
};

const propertyConFotos: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
  fotos: ["https://example.com/foto1.jpg", "https://example.com/foto2.jpg"],
};

function tokkoWith(property: Property | null): TokkoQueries {
  return {
    searchProperties: vi.fn(async () => (property ? [property] : [])),
    getProperty: vi.fn(async () => property),
  };
}

describe("runPedidoFichaMultimedia", () => {
  it("arma el template con la dirección corta y devuelve las URLs de fotos", async () => {
    const result = await runPedidoFichaMultimedia(
      { intentId: "pedido_ficha_multimedia", confidence: 0.9, searchQuery: "Palermo" },
      intent,
      tokkoWith(propertyConFotos)
    );

    expect(result.responseText).toBe("Te paso el material de Depto Palermo:");
    expect(result.mediaUrls).toEqual(propertyConFotos.fotos);
    expect(result.toolsCalled).toEqual(["tokko.search_properties", "tokko.get_property"]);
  });

  it("no inventa fotos si la propiedad no tiene ninguna cargada", async () => {
    const sinFotos: Property = { ...propertyConFotos, fotos: undefined };
    const result = await runPedidoFichaMultimedia(
      { intentId: "pedido_ficha_multimedia", confidence: 0.9, searchQuery: "Palermo" },
      intent,
      tokkoWith(sinFotos)
    );

    expect(result.mediaUrls).toEqual([]);
    expect(result.responseText).toMatch(/no tengo fotos/);
  });

  it("pide aclaración si no encuentra la propiedad", async () => {
    const result = await runPedidoFichaMultimedia(
      { intentId: "pedido_ficha_multimedia", confidence: 0.9, searchQuery: "no existe" },
      intent,
      tokkoWith(null)
    );

    expect(result.mediaUrls).toEqual([]);
    expect(result.toolsCalled).toEqual(["tokko.search_properties"]);
  });
});
