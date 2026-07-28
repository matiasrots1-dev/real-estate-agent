import Anthropic from "@anthropic-ai/sdk";

export interface ConfirmationResult {
  confirmed: boolean;
}

export interface ConfirmationClassifier {
  extractConfirmation(message: string): Promise<ConfirmationResult>;
}

const TOOL_NAME = "extract_confirmation";
// 32 no alcanzaba: se confirmó en vivo (live testing del Bloque 10,
// 2026-07-28) que Claude puede gastar esos 32 tokens en el preámbulo del
// tool_use y cortarse (`stop_reason: "max_tokens"`) antes de escribir
// "confirmed" — el `input` queda `{}`. Ver el chequeo de abajo, que además
// no confía en que subir este número alcance para siempre.
const MAX_TOKENS = 64;

/**
 * broker_accion_directa (docs/TASKS.md Bloque 10): el turno 2 del gate bulk
 * ("esto le va a llegar a 14 contactos, ¿confirmás?") necesita un sí/no
 * simple. Ante cualquier AMBIGÜEDAD EN EL CONTENIDO (dudas, silencio sobre
 * el tema, un "no" claro), `confirmed: false` — nunca ejecutamos una acción
 * masiva sin una confirmación clara.
 *
 * Eso es distinto de no poder leer la respuesta de Claude (truncada por
 * `max_tokens`, `input` incompleto, sin ningún `tool_use`): tratar eso como
 * `confirmed: false` funcionaba por casualidad (la rama seria la segura),
 * no por diseño — y ocultaba el error real. Acá se detecta explícitamente
 * y se tira una excepción; el caller (`continueBrokerAccionDirecta`) la
 * atrapa, no ejecuta nada, no descarta el plan pendiente, y le pide al
 * broker que confirme de nuevo en vez de asumir un "no" silencioso.
 */
export class ClaudeConfirmationClassifier implements ConfirmationClassifier {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async extractConfirmation(message: string): Promise<ConfirmationResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system:
        "El broker está respondiendo a un pedido de confirmación de una acción. Decidí si confirmó " +
        '("confirmed": true) o no (cualquier cosa que no sea un sí claro — dudas, silencio sobre el tema, ' +
        'un "no" — es "confirmed": false).',
      messages: [{ role: "user", content: `Respuesta del broker: "${message}"` }],
      tools: [
        {
          name: TOOL_NAME,
          description: "Devuelve si el broker confirmó la acción propuesta.",
          input_schema: {
            type: "object",
            properties: { confirmed: { type: "boolean" } },
            required: ["confirmed"],
          },
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUse) {
      throw new Error(
        `ClaudeConfirmationClassifier: Claude no devolvió ningún tool_use (stop_reason="${response.stop_reason}").`
      );
    }

    const input = toolUse.input as Partial<ConfirmationResult>;
    if (typeof input.confirmed !== "boolean") {
      throw new Error(
        `ClaudeConfirmationClassifier: respuesta incompleta o mal formada de Claude ` +
          `(stop_reason="${response.stop_reason}", input=${JSON.stringify(input)}) — probable truncamiento por max_tokens.`
      );
    }
    return { confirmed: input.confirmed };
  }
}
