import type { Intent } from "shared-types";
import type { IntentClassification } from "./classifier.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import { findPropertyByQuery } from "./tokkoLookup.js";

export interface PedidoFichaMultimediaResult {
  responseText: string;
  toolsCalled: string[];
  /** URLs de fotos para mandar como mensajes de imagen aparte (whatsapp.send_media). */
  mediaUrls: string[];
}

const NOT_FOUND_FALLBACK = "¿De qué propiedad querés el material? Pasame la dirección o el link del aviso.";
const NO_MEDIA_FALLBACK = "Todavía no tengo fotos cargadas de esa propiedad, te confirmo en breve.";

/**
 * docs/intent_catalog.yaml: pedido_ficha_multimedia. Solo manda fotos por
 * ahora (planos/videos necesitarían tipos de mensaje de WhatsApp
 * (document/video) que este sender todavía no implementa — no inventamos
 * que se mandó algo que no se mandó).
 */
export async function runPedidoFichaMultimedia(
  classification: IntentClassification,
  intent: Intent,
  tokko: TokkoQueries
): Promise<PedidoFichaMultimediaResult> {
  const { property, toolsCalled } = await findPropertyByQuery(tokko, classification.searchQuery);

  if (!property) {
    return { responseText: NOT_FOUND_FALLBACK, toolsCalled, mediaUrls: [] };
  }

  const fotos = property.fotos ?? [];
  if (fotos.length === 0) {
    return { responseText: NO_MEDIA_FALLBACK, toolsCalled, mediaUrls: [] };
  }

  const template = intent.response.template ?? "Te paso el material de {direccion_corta}:";
  const responseText = template.replace("{direccion_corta}", property.direccionCorta);

  return { responseText, toolsCalled, mediaUrls: fotos };
}
