import Anthropic from "@anthropic-ai/sdk";
import type { IntentCatalog } from "shared-types";

export interface IntentClassification {
  intentId: string;
  confidence: number;
  /** Consulta de búsqueda extraída del mensaje libre (ej. barrio/dirección), si aplica al intent. */
  searchQuery?: string;
}

export interface IntentClassifier {
  classify(message: string, catalog: IntentCatalog): Promise<IntentClassification>;
}

const CLASSIFY_TOOL_NAME = "classify_intent";

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

  async classify(message: string, catalog: IntentCatalog): Promise<IntentClassification> {
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
        "mensaje del cliente contra el catálogo de intents provisto. Si ninguno matchea con " +
        "confianza razonable, devolvé intent_id 'fallback_low_confidence' con confidence baja. " +
        "Nunca inventes un intent que no esté en el catálogo.",
      messages: [
        {
          role: "user",
          content: `Catálogo de intents (JSON): ${JSON.stringify(intentSummaries)}\n\nMensaje del cliente: "${message}"`,
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
