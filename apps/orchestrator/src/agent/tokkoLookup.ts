import type { Property } from "shared-types";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";

export interface PropertyLookupResult {
  property: Property | null;
  toolsCalled: string[];
}

/**
 * Búsqueda + ficha completa, compartida entre los intents que consultan una
 * sola propiedad (consulta_disponibilidad, consulta_precio_condiciones,
 * pedido_ficha_multimedia). El `query` es texto libre extraído del mensaje
 * por el classifier — nunca exacto, ver el matching por palabra de
 * mcp-tokko/MockTokkoClient.
 */
export async function findPropertyByQuery(
  tokko: TokkoQueries,
  query: string | undefined
): Promise<PropertyLookupResult> {
  const toolsCalled = ["tokko.search_properties"];
  const trimmed = query?.trim();
  const matches = await tokko.searchProperties(trimmed ? { direccion: trimmed } : {});

  if (matches.length === 0) {
    return { property: null, toolsCalled };
  }

  toolsCalled.push("tokko.get_property");
  const property = await tokko.getProperty(matches[0].id);
  return { property, toolsCalled };
}

/**
 * Arma el objeto de grounding con solo los campos pedidos por el intent.
 * Un campo pedido que la propiedad no tiene cargado se pasa como `null`
 * explícito (no se omite) para que el composer lo mencione como "no
 * disponible" en vez de inventarlo o ignorarlo en silencio.
 */
export function pickGroundingData(
  available: Record<string, unknown>,
  wantedFields: string[]
): Record<string, unknown> {
  const wanted = wantedFields.length > 0 ? wantedFields : Object.keys(available);
  return Object.fromEntries(wanted.map((field) => [field, available[field] ?? null]));
}
