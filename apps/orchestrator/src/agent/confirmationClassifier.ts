import Anthropic from "@anthropic-ai/sdk";

export interface ConfirmationResult {
  confirmed: boolean;
}

export interface ConfirmationClassifier {
  extractConfirmation(message: string): Promise<ConfirmationResult>;
}

const TOOL_NAME = "extract_confirmation";

/**
 * broker_accion_directa (docs/TASKS.md Bloque 10): el turno 2 del gate bulk
 * ("esto le va a llegar a 14 contactos, ¿confirmás?") necesita un sí/no
 * simple. Ante cualquier ambigüedad, `confirmed: false` — nunca ejecutamos
 * una acción masiva sin una confirmación clara (ver
 * `runBrokerAccionDirecta`/`continueBrokerAccionDirecta`).
 */
export class ClaudeConfirmationClassifier implements ConfirmationClassifier {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async extractConfirmation(message: string): Promise<ConfirmationResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 32,
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
      throw new Error("Claude no devolvió la confirmación.");
    }
    return toolUse.input as ConfirmationResult;
  }
}
