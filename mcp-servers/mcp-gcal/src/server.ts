import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleCalendarClient, type CalendarClient } from "./calendarClient.js";
import { loadGcalConfigFromEnv } from "./config.js";
import { createFreebusyHandler, freebusyInputShape } from "./tools/freebusy.js";
import { createCreateEventHandler, createEventInputShape } from "./tools/createEvent.js";
import { createPatchEventHandler, patchEventInputShape } from "./tools/patchEvent.js";
import { createDeleteEventHandler, deleteEventInputShape } from "./tools/deleteEvent.js";
import { createGetEventHandler, getEventInputShape } from "./tools/getEvent.js";
import { createListEventsHandler, listEventsInputShape } from "./tools/listEvents.js";

export function createServer(client?: CalendarClient): McpServer {
  const calendarClient = client ?? new GoogleCalendarClient(loadGcalConfigFromEnv());

  const server = new McpServer({ name: "mcp-gcal", version: "0.1.0" });

  server.registerTool(
    "freebusy",
    {
      title: "Disponibilidad del calendario",
      description: "Devuelve los bloques ocupados del calendario dedicado en un rango de fechas.",
      inputSchema: freebusyInputShape,
    },
    createFreebusyHandler(calendarClient)
  );

  server.registerTool(
    "create_event",
    {
      title: "Crear evento",
      description: "Crea una visita en el calendario dedicado (docs/intent_catalog.yaml: agendar_visita).",
      inputSchema: createEventInputShape,
    },
    createCreateEventHandler(calendarClient)
  );

  server.registerTool(
    "patch_event",
    {
      title: "Modificar evento",
      description: "Reprograma una visita existente (docs/intent_catalog.yaml: reprogramar_cancelar_visita).",
      inputSchema: patchEventInputShape,
    },
    createPatchEventHandler(calendarClient)
  );

  server.registerTool(
    "delete_event",
    {
      title: "Cancelar evento",
      description: "Cancela una visita existente (docs/intent_catalog.yaml: reprogramar_cancelar_visita).",
      inputSchema: deleteEventInputShape,
    },
    createDeleteEventHandler(calendarClient)
  );

  server.registerTool(
    "get_event",
    {
      title: "Obtener evento",
      description: "Trae el detalle de una visita agendada por id.",
      inputSchema: getEventInputShape,
    },
    createGetEventHandler(calendarClient)
  );

  server.registerTool(
    "list_events",
    {
      title: "Listar eventos",
      description: "Lista las visitas agendadas en un rango de fechas (docs/intent_catalog.yaml: broker_resumen_agenda).",
      inputSchema: listEventsInputShape,
    },
    createListEventsHandler(calendarClient)
  );

  return server;
}
