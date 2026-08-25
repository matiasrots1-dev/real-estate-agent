import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TokkoClient } from "./tokkoClient.js";
import { MockTokkoClient } from "./mockTokkoClient.js";
import { RealTokkoClient } from "./realTokkoClient.js";
import { createSearchPropertiesHandler, searchPropertiesInputShape } from "./tools/searchProperties.js";
import { createGetPropertyHandler, getPropertyInputShape } from "./tools/getProperty.js";
import { createSearchLeadsHandler, searchLeadsInputShape } from "./tools/searchLeads.js";
import { createGetLeadHandler, getLeadInputShape } from "./tools/getLead.js";
import { createLogActivityHandler, logActivityInputShape } from "./tools/logActivity.js";

function crearClientePorEntorno(): TokkoClient {
  const apiKey = process.env.TOKKO_API_KEY;
  if (!apiKey) {
    console.warn(
      "[mcp-tokko] TOKKO_API_KEY vacia: se usa MockTokkoClient. Las propiedades, precios y disponibilidad que devuelva el agente son INVENTADAS."
    );
    return new MockTokkoClient();
  }
  const branchId = process.env.TOKKO_BRANCH_ID ? Number(process.env.TOKKO_BRANCH_ID) : undefined;
  if (branchId === undefined) {
    console.warn(
      "[mcp-tokko] TOKKO_BRANCH_ID sin configurar: se exponen las propiedades de TODAS las sucursales de la cuenta."
    );
  }
  console.log("[mcp-tokko] usando Tokko REAL" + (branchId !== undefined ? " (sucursal " + branchId + ")" : ""));
  return new RealTokkoClient({ apiKey, baseUrl: process.env.TOKKO_API_BASE_URL, branchId });
}

export function createServer(client?: TokkoClient): McpServer {
  // Real si hay credenciales, mock si no. La eleccion es por presencia de la
  // key y se anuncia siempre: correr contra el mock creyendo que son datos
  // reales es peor que no tener datos -- el agente cita precios inventados con
  // total confianza (docs/TASKS.md Bloque 26).
  const tokkoClient = client ?? crearClientePorEntorno();

  const server = new McpServer({ name: "mcp-tokko", version: "0.1.0" });

  server.registerTool(
    "search_properties",
    {
      title: "Buscar propiedades",
      description: "Busca propiedades por barrio, dirección, tipo o código (docs/intent_catalog.yaml: consulta_disponibilidad).",
      inputSchema: searchPropertiesInputShape,
    },
    createSearchPropertiesHandler(tokkoClient)
  );

  server.registerTool(
    "get_property",
    {
      title: "Obtener ficha de propiedad",
      description: "Trae la ficha completa de una propiedad por id (precio, expensas, requisitos, media).",
      inputSchema: getPropertyInputShape,
    },
    createGetPropertyHandler(tokkoClient)
  );

  server.registerTool(
    "search_leads",
    {
      title: "Buscar leads",
      description: "Busca leads por temperatura o días sin respuesta (docs/intent_catalog.yaml: broker_resumen_leads, recontacto_lead_frio).",
      inputSchema: searchLeadsInputShape,
    },
    createSearchLeadsHandler(tokkoClient)
  );

  server.registerTool(
    "get_lead",
    {
      title: "Obtener lead",
      description: "Trae el detalle de un lead por id.",
      inputSchema: getLeadInputShape,
    },
    createGetLeadHandler(tokkoClient)
  );

  server.registerTool(
    "log_activity",
    {
      title: "Loguear actividad",
      description: "Registra una actividad sobre un lead/propiedad (ej. visita agendada, consulta respondida por el bot).",
      inputSchema: logActivityInputShape,
    },
    createLogActivityHandler(tokkoClient)
  );

  return server;
}
