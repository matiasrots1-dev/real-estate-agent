import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TokkoClient } from "./tokkoClient.js";
import { MockTokkoClient } from "./mockTokkoClient.js";
import { createSearchPropertiesHandler, searchPropertiesInputShape } from "./tools/searchProperties.js";
import { createGetPropertyHandler, getPropertyInputShape } from "./tools/getProperty.js";
import { createSearchLeadsHandler, searchLeadsInputShape } from "./tools/searchLeads.js";
import { createGetLeadHandler, getLeadInputShape } from "./tools/getLead.js";
import { createLogActivityHandler, logActivityInputShape } from "./tools/logActivity.js";

export function createServer(client?: TokkoClient): McpServer {
  // TODO: reemplazar por credenciales reales de Tokko una vez confirmado el
  // acceso (ver CLAUDE.md secc. 5). Hasta entonces, mock en memoria.
  const tokkoClient = client ?? new MockTokkoClient();

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
