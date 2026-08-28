import Anthropic from "@anthropic-ai/sdk";
import type { IntentCatalog } from "shared-types";

export interface IntentClassification {
  intentId: string;
  confidence: number;
  /** Consulta de búsqueda extraída del mensaje libre (ej. barrio/dirección), si aplica al intent. */
  searchQuery?: string;
}

/**
 * El hilo de la conversación, para que el clasificador no vea el mensaje
 * aislado.
 *
 * Sale de etiquetar a mano 43 conversaciones reales: **los 5 leads que el
 * clasificador perdía enteros eran continuaciones** — "sí dale", "Recordame el
 * link porfa", "Mayormente eso". Ninguno es clasificable solo, y ningún intent
 * nuevo los arregla. Dos de esos cinco eran además el ÚNICO mensaje de la
 * conversación: respondían a algo que el broker había mandado.
 *
 * Por eso el contexto tiene dos partes, y la segunda es la que más aporta:
 * saber que hubo un contacto saliente convierte "recordame el link" de
 * inclasificable en un pedido de ficha.
 *
 * **No incluye qué dijo el broker**: eso no se guarda de forma vinculable al
 * destinatario, por la decisión de privacidad del corpus de estilo.
 */
export interface ContextoConversacion {
  /** Mensajes entrantes previos, del más viejo al más nuevo. */
  mensajesPrevios: string[];
  /** Hace cuántas horas el broker le escribió a esta persona, si le escribió. */
  horasDesdeContactoDelBroker?: number;
}

export interface IntentClassifier {
  classify(
    message: string,
    catalog: IntentCatalog,
    contexto?: ContextoConversacion
  ): Promise<IntentClassification>;
}

const CLASSIFY_TOOL_NAME = "classify_intent";

/**
 * Techos del contexto. El clasificador corre en el camino crítico de cada
 * webhook (1686-2241 ms medidos), y mandar la conversación entera multiplica
 * los tokens de entrada en cada mensaje. Con 4 mensajes alcanza para resolver
 * los casos observados.
 */
const MAX_MENSAJES_PREVIOS = 4;
const MAX_CARACTERES_POR_MENSAJE = 220;

function armarBloqueDeContexto(contexto?: ContextoConversacion): string {
  if (!contexto) return "";

  const partes: string[] = [];

  if (contexto.horasDesdeContactoDelBroker !== undefined) {
    const h = Math.round(contexto.horasDesdeContactoDelBroker);
    partes.push(
      `DATO IMPORTANTE: el broker le escribió a esta persona hace ${h} ${h === 1 ? "hora" : "horas"}. ` +
        `Es muy probable que este mensaje sea una RESPUESTA a ese contacto, no una consulta nueva.`
    );
  }

  const previos = contexto.mensajesPrevios
    .slice(-MAX_MENSAJES_PREVIOS)
    .map((m) => m.replace(/\s+/g, " ").trim().slice(0, MAX_CARACTERES_POR_MENSAJE))
    .filter(Boolean);

  if (previos.length > 0) {
    partes.push(
      `Mensajes anteriores de esta misma persona (del más viejo al más nuevo):\n` +
        previos.map((m) => `  - "${m}"`).join("\n")
    );
  }

  return partes.length > 0 ? `\n\n${partes.join("\n\n")}` : "";
}

/**
 * Router de intents real, vía tool-use forzado de Claude (docs/SOW.md secc.
 * 4.5). El catálogo completo (id + description + ejemplos) se pasa como
 * contexto en cada llamada: es la fuente de verdad de negocio y no vive
 * hardcodeada acá (ver CLAUDE.md secc. 7).
 */
export class ClaudeIntentClassifier implements IntentClassifier {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async classify(
    message: string,
    catalog: IntentCatalog,
    contexto?: ContextoConversacion
  ): Promise<IntentClassification> {
    const intentSummaries = catalog.intents
      .filter((intent) => intent.triggers)
      .map((intent) => ({
        id: intent.id,
        description: intent.description,
        examples: intent.triggers?.examples ?? [],
      }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 256,
      system:
        "Sos el router de intents de un agente inmobiliario por WhatsApp (es-AR). Clasificá el " +
        "ÚLTIMO mensaje del cliente contra el catálogo de intents provisto. Si ninguno matchea con " +
        "confianza razonable, devolvé intent_id 'fallback_low_confidence' con confidence baja. " +
        "Nunca inventes un intent que no esté en el catálogo.\n\n" +
        "Puede venir contexto de la conversación. Usalo para interpretar mensajes cortos o " +
        "ambiguos: 'sí dale', 'recordame el link' o 'no, gracias' no significan nada sueltos, " +
        "pero sí dentro de su hilo. Clasificá SIEMPRE el último mensaje, nunca los anteriores: " +
        "el contexto es para entenderlo, no para reemplazarlo.",
      messages: [
        {
          role: "user",
          content:
            `Catálogo de intents (JSON): ${JSON.stringify(intentSummaries)}` +
            armarBloqueDeContexto(contexto) +
            `\n\nÚltimo mensaje del cliente (es el que hay que clasificar): "${message}"`,
        },
      ],
      tools: [
        {
          name: CLASSIFY_TOOL_NAME,
          description:
            "Devuelve el intent matcheado, la confianza (0 a 1), y opcionalmente una consulta de " +
            "búsqueda extraída del mensaje (ej. barrio o dirección mencionados por el cliente).",
          input_schema: {
            type: "object",
            properties: {
              intent_id: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              search_query: { type: "string" },
            },
            required: ["intent_id", "confidence"],
          },
        },
      ],
      tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUse) {
      throw new Error("Claude no devolvió una clasificación de intent.");
    }
    const input = toolUse.input as { intent_id: string; confidence: number; search_query?: string };
    return { intentId: input.intent_id, confidence: input.confidence, searchQuery: input.search_query };
  }
}
