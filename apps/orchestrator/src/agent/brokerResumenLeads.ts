import type { Intent } from "shared-types";
import type { ResponseComposer } from "./composer.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";

export interface BrokerResumenLeadsResult {
  responseText: string;
  toolsCalled: string[];
}

/**
 * docs/intent_catalog.yaml: broker_resumen_leads (canal broker). Un solo
 * llamado a `tokko.search_leads` sin filtro, agrupado por temperatura acá
 * — nunca inventa cuántos leads hay de cada tipo, son los que Tokko
 * devolvió.
 */
export async function runBrokerResumenLeads(
  intent: Intent,
  tokko: TokkoQueries,
  composer: ResponseComposer,
  language: string
): Promise<BrokerResumenLeadsResult> {
  const leads = await tokko.searchLeads({});

  const groundingData = {
    total: leads.length,
    nuevos: leads.filter((lead) => lead.temperatura === "nuevo").length,
    tibios: leads.filter((lead) => lead.temperatura === "tibio").length,
    frios: leads.filter((lead) => lead.temperatura === "frio").length,
    listado: leads.map((lead) => ({
      nombre: lead.nombre,
      temperatura: lead.temperatura,
      diasSinRespuesta: lead.diasSinRespuesta,
    })),
  };

  const responseText = await composer.compose({
    intentDescription: intent.description,
    groundingData,
    language,
  });

  return { responseText, toolsCalled: ["tokko.search_leads"] };
}
