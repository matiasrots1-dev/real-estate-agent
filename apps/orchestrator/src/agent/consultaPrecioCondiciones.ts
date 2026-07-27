import type { Intent } from "shared-types";
import type { IntentClassification } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import { findPropertyByQuery, pickGroundingData } from "./tokkoLookup.js";

export interface ConsultaPrecioCondicionesResult {
  responseText: string;
  toolsCalled: string[];
}

const DEFAULT_GROUNDING_FIELDS = ["precio", "expensas", "requisitos", "garantiasAceptadas"];

const NOT_FOUND_FALLBACK =
  "No encontré esa propiedad con esos datos, ¿me pasás la dirección o el link del aviso?";

/**
 * Precio/expensas/requisitos/garantías (docs/intent_catalog.yaml). Mismo
 * patrón de búsqueda que consulta_disponibilidad (tokkoLookup.ts) — la
 * diferencia es qué campos pide de grounding. Si Tokko no tiene cargado
 * alguno de esos campos, se lo pasa en null al composer, que usa
 * `fallback_if_missing_field` en vez de inventar un valor.
 */
export async function runConsultaPrecioCondiciones(
  classification: IntentClassification,
  intent: Intent,
  tokko: TokkoQueries,
  composer: ResponseComposer,
  language: string
): Promise<ConsultaPrecioCondicionesResult> {
  const { property, toolsCalled } = await findPropertyByQuery(tokko, classification.searchQuery);

  if (!property) {
    return {
      responseText: intent.response.fallback_if_not_found ?? NOT_FOUND_FALLBACK,
      toolsCalled,
    };
  }

  const groundingData = pickGroundingData(
    {
      precio: property.precio,
      expensas: property.expensas,
      requisitos: property.requisitos,
      garantiasAceptadas: property.garantiasAceptadas,
    },
    intent.response.grounding_fields ?? DEFAULT_GROUNDING_FIELDS
  );

  if (intent.response.fallback_if_missing_field) {
    groundingData._nota_si_falta_un_dato = intent.response.fallback_if_missing_field;
  }

  const responseText = await composer.compose({
    intentDescription: intent.description,
    groundingData,
    language,
  });

  return { responseText, toolsCalled };
}
