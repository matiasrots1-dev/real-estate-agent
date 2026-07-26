import type { Intent, Property } from "shared-types";
import type { IntentClassification } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";

export interface ConsultaDisponibilidadResult {
  responseText: string;
  toolsCalled: string[];
}

const DEFAULT_GROUNDING_FIELDS = ["estado", "direccion", "tipo", "precio"];

function pickGroundingData(property: Property, fields: string[]): Record<string, unknown> {
  const available: Record<string, unknown> = {
    estado: property.estado,
    direccion: property.direccion,
    tipo: property.tipo,
    precio: property.precio,
  };
  const wanted = fields.length > 0 ? fields : DEFAULT_GROUNDING_FIELDS;
  return Object.fromEntries(Object.entries(available).filter(([key]) => wanted.includes(key)));
}

/**
 * Único intent implementado de punta a punta en el Bloque 3 (docs/TASKS.md).
 * Busca la propiedad mencionada en Tokko (real vía MCP, mock hasta que haya
 * credenciales) y redacta la respuesta solo con datos que el tool devolvió
 * — nunca inventa precio/disponibilidad (CLAUDE.md secc. 7).
 */
export async function runConsultaDisponibilidad(
  classification: IntentClassification,
  intent: Intent,
  tokko: TokkoQueries,
  composer: ResponseComposer,
  language: string
): Promise<ConsultaDisponibilidadResult> {
  const toolsCalled: string[] = [];
  const query = classification.searchQuery?.trim();

  toolsCalled.push("tokko.search_properties");
  const matches = await tokko.searchProperties(query ? { direccion: query } : {});

  if (matches.length === 0) {
    return {
      responseText:
        intent.response.fallback_if_not_found ??
        "No encontré esa propiedad con esos datos, ¿me pasás la dirección o el link del aviso?",
      toolsCalled,
    };
  }

  toolsCalled.push("tokko.get_property");
  const property = await tokko.getProperty(matches[0].id);

  if (!property) {
    return {
      responseText:
        intent.response.fallback_if_not_found ??
        "No encontré esa propiedad con esos datos, ¿me pasás la dirección o el link del aviso?",
      toolsCalled,
    };
  }

  const groundingData = pickGroundingData(property, intent.response.grounding_fields ?? []);
  const responseText = await composer.compose({
    intentDescription: intent.description,
    groundingData,
    language,
  });

  return { responseText, toolsCalled };
}
