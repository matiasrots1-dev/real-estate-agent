import Anthropic from "@anthropic-ai/sdk";
import type { LeadTemperature } from "shared-types";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import { findPropertyByQuery } from "./tokkoLookup.js";

export type PlannedAction =
  | { type: "gcal_create_event"; leadId: string; propertyId: string; startDateTime: string; endDateTime: string; summary: string }
  | { type: "gcal_patch_event"; leadId: string; gcalEventId: string; startDateTime?: string; endDateTime?: string; summary?: string }
  | { type: "whatsapp_send_message"; leadId: string; phone: string; message: string }
  | {
      type: "whatsapp_send_template";
      leadId: string;
      phone: string;
      templateName: string;
      languageCode: string;
      bodyParams: string[];
    };

export interface ActionPlan {
  actions: PlannedAction[];
  /** Texto para el broker: preview (si el plan es bulk) o resumen de lo ejecutado (si no lo es). */
  previewSummary: string;
}

export interface BrokerAccionDirectaPlanner {
  plan(message: string): Promise<ActionPlan>;
}

const SUBMIT_PLAN_TOOL = "submit_action_plan";
const FIND_PROPERTY_TOOL = "tokko_find_property";
const SEARCH_LEADS_TOOL = "tokko_search_leads";
const MAX_PLANNING_TURNS = 6;

const PLANNING_SYSTEM_PROMPT =
  "Sos el planificador de broker_accion_directa: el broker (dueño de la inmobiliaria) te da una orden en " +
  "lenguaje libre sobre uno o más clientes (leads) y vos decidís qué acciones concretas hacen falta. " +
  "Primero investigá lo que necesites con las tools de consulta (tokko_find_property, tokko_search_leads). " +
  "Cuando ya sepas qué hacer, terminá SIEMPRE llamando a submit_action_plan con la lista de acciones " +
  "concretas (una por cliente/acción) y un preview_summary en es-AR de 1-2 frases, dirigido al broker " +
  "(nunca al cliente), describiendo qué se va a hacer. Nunca inventes un lead_id, phone o property_id que " +
  "no haya salido de una tool — si no encontrás lo que la orden pide, devolvé actions: [] y explicá en " +
  "preview_summary qué no se pudo resolver.";

const PLANNING_TOOLS: Anthropic.Tool[] = [
  {
    name: FIND_PROPERTY_TOOL,
    description: "Busca una propiedad por texto libre (dirección/barrio) y devuelve su ficha completa.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: SEARCH_LEADS_TOOL,
    description: "Busca leads por temperatura y/o días mínimos sin respuesta.",
    input_schema: {
      type: "object",
      properties: {
        temperatura: { type: "string", enum: ["nuevo", "tibio", "frio"] },
        dias_sin_respuesta_min: { type: "number" },
      },
    },
  },
  {
    name: SUBMIT_PLAN_TOOL,
    description: "Devuelve el plan final de acciones a ejecutar (o un plan vacío si no se pudo resolver la orden).",
    input_schema: {
      type: "object",
      properties: {
        preview_summary: { type: "string" },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["gcal_create_event", "gcal_patch_event", "whatsapp_send_message", "whatsapp_send_template"],
              },
              lead_id: { type: "string" },
              phone: { type: "string" },
              property_id: { type: "string" },
              gcal_event_id: { type: "string" },
              start_datetime: { type: "string" },
              end_datetime: { type: "string" },
              summary: { type: "string" },
              message: { type: "string" },
              template_name: { type: "string" },
              language_code: { type: "string" },
              body_params: { type: "array", items: { type: "string" } },
            },
            required: ["type", "lead_id"],
          },
        },
      },
      required: ["preview_summary", "actions"],
    },
  },
];

interface RawPlannedAction {
  type: string;
  lead_id: string;
  phone?: string;
  property_id?: string;
  gcal_event_id?: string;
  start_datetime?: string;
  end_datetime?: string;
  summary?: string;
  message?: string;
  template_name?: string;
  language_code?: string;
  body_params?: string[];
}

function toPlannedAction(raw: RawPlannedAction): PlannedAction {
  switch (raw.type) {
    case "gcal_create_event":
      if (!raw.property_id || !raw.start_datetime || !raw.end_datetime || !raw.summary) {
        throw new Error(`broker_accion_directa: plan de gcal_create_event incompleto para el lead "${raw.lead_id}".`);
      }
      return {
        type: "gcal_create_event",
        leadId: raw.lead_id,
        propertyId: raw.property_id,
        startDateTime: raw.start_datetime,
        endDateTime: raw.end_datetime,
        summary: raw.summary,
      };
    case "gcal_patch_event":
      if (!raw.gcal_event_id) {
        throw new Error(`broker_accion_directa: plan de gcal_patch_event sin gcal_event_id para el lead "${raw.lead_id}".`);
      }
      return {
        type: "gcal_patch_event",
        leadId: raw.lead_id,
        gcalEventId: raw.gcal_event_id,
        startDateTime: raw.start_datetime,
        endDateTime: raw.end_datetime,
        summary: raw.summary,
      };
    case "whatsapp_send_message":
      if (!raw.phone || !raw.message) {
        throw new Error(`broker_accion_directa: plan de whatsapp_send_message incompleto para el lead "${raw.lead_id}".`);
      }
      return { type: "whatsapp_send_message", leadId: raw.lead_id, phone: raw.phone, message: raw.message };
    case "whatsapp_send_template":
      if (!raw.phone || !raw.template_name || !raw.language_code) {
        throw new Error(`broker_accion_directa: plan de whatsapp_send_template incompleto para el lead "${raw.lead_id}".`);
      }
      return {
        type: "whatsapp_send_template",
        leadId: raw.lead_id,
        phone: raw.phone,
        templateName: raw.template_name,
        languageCode: raw.language_code,
        bodyParams: raw.body_params ?? [],
      };
    default:
      throw new Error(`broker_accion_directa: tipo de acción desconocido en el plan: "${raw.type}".`);
  }
}

function parseActionPlan(rawInput: unknown): ActionPlan {
  const input = rawInput as { preview_summary: string; actions: RawPlannedAction[] };
  return { actions: input.actions.map(toPlannedAction), previewSummary: input.preview_summary };
}

/**
 * broker_accion_directa (docs/intent_catalog.yaml): a diferencia de todos
 * los demás intents, acá Claude decide dinámicamente qué acciones tomar a
 * partir de una orden en lenguaje libre. Separamos "planificar" (este
 * archivo: Claude investiga con tools de solo lectura reales y devuelve un
 * plan estructurado vía `submit_action_plan`) de "ejecutar"
 * (brokerAccionDirectaExecutor.ts) a propósito: así el gate de confirmación
 * bulk (docs/TASKS.md Bloque 10) puede interceptar el plan ANTES de tocar
 * Calendar/WhatsApp, en vez de depender de que el modelo respete una
 * instrucción de "esperá mi confirmación" en medio de un loop con las tools
 * de escritura reales ya disponibles.
 */
export class ClaudeBrokerAccionDirectaPlanner implements BrokerAccionDirectaPlanner {
  constructor(
    private readonly client: Anthropic,
    private readonly tokko: TokkoQueries,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async plan(message: string): Promise<ActionPlan> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Orden del broker: "${message}"` }];

    for (let turn = 0; turn < MAX_PLANNING_TURNS; turn++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: PLANNING_SYSTEM_PROMPT,
        messages,
        tools: PLANNING_TOOLS,
        tool_choice: { type: "any" },
      });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );
      if (toolUses.length === 0) {
        throw new Error("broker_accion_directa: Claude no llamó ninguna tool durante la planificación.");
      }

      const submitPlan = toolUses.find((toolUse) => toolUse.name === SUBMIT_PLAN_TOOL);
      if (submitPlan) {
        return parseActionPlan(submitPlan.input);
      }

      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const result = await this.runReadTool(toolUse);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
    }

    throw new Error("broker_accion_directa: no se llegó a un plan de acción después de varios turnos de planificación.");
  }

  private async runReadTool(toolUse: Anthropic.ToolUseBlock): Promise<unknown> {
    if (toolUse.name === FIND_PROPERTY_TOOL) {
      const input = toolUse.input as { query: string };
      const { property } = await findPropertyByQuery(this.tokko, input.query);
      return property ?? { found: false };
    }
    if (toolUse.name === SEARCH_LEADS_TOOL) {
      const input = toolUse.input as { temperatura?: LeadTemperature; dias_sin_respuesta_min?: number };
      return this.tokko.searchLeads({ temperatura: input.temperatura, diasSinRespuestaMin: input.dias_sin_respuesta_min });
    }
    throw new Error(`broker_accion_directa: tool de planificación desconocida: "${toolUse.name}".`);
  }
}
