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
  // console.error y NO console.log: en un server MCP por stdio, stdout ES el
  // canal del protocolo JSON-RPC. Escribir ahi lo corrompe, y ademas el texto
  // nunca llega a la terminal de quien levanto el orchestrator.
  console.error("[mcp-tokko] usando Tokko REAL" + (branchId !== undefined ? " (sucursal " + branchId + ")" : ""));
  return new RealTokkoClient({ apiKey, baseUrl: process.env.TOKKO_API_BASE_URL, branchId });
}

export function createServer(client?: TokkoClient): McpServer {
  // Real si hay credenciales, mock si no. La eleccion es por presencia de la
  // key y se anuncia siempre: correr contra el mock creyendo que son datos
  // reales es peor que no tener datos -- el agente cita precios inventados con
  // total confianza (docs/TASKS.md Bloque 26).
  const tokkoClient = client ?? crearClientePorEntorno();
  // Que fuente se esta usando, expuesto COMO DATO y no como log. Un banner en
  // un proceso hijo por stdio es invisible: stdout es el canal del protocolo y
  // stderr no llega a la terminal de quien levanto el orchestrator. La unica
  // forma confiable de confirmarlo es preguntarselo.
  const fuente = client ? "inyectado" : process.env.TOKKO_API_KEY ? "real" : "mock";
  const branchId = process.env.TOKKO_BRANCH_ID ? Number(process.env.TOKKO_BRANCH_ID) : null;

  const server = new McpServer({ name: "mcp-tokko", version: "0.1.0" });

  server.registerTool(
    "tokko_fuente_datos",
    {
      title: "Fuente de datos en uso",
      description: "Devuelve si las propiedades salen de Tokko real o del mock, y de que sucursal.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ fuente, branchId }) }],
    })
  );

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
