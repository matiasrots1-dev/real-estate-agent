import Anthropic from "@anthropic-ai/sdk";

export interface SlotConfirmationResult {
  /** Índice (0-based) del horario propuesto que el cliente eligió, o null si no eligió ninguno. */
  chosenIndex: number | null;
}

export interface SlotConfirmationClassifier {
  matchSlot(message: string, proposedSlotsLabels: string[]): Promise<SlotConfirmationResult>;
}

const TOOL_NAME = "match_slot";

/**
 * Segundo turno de agendar_visita/reprogramar_cancelar_visita: el cliente ya
 * recibió una lista de horarios propuestos y esta es su respuesta libre
 * ("el segundo", "el sábado a las 15", "ninguno me sirve"). Un intent
 * `NotImplementedIntentError`-safe: si no matchea nada, el caller escala en
 * vez de adivinar (ver agendarVisita.ts).
 */
export class ClaudeSlotConfirmationClassifier implements SlotConfirmationClassifier {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async matchSlot(message: string, proposedSlotsLabels: string[]): Promise<SlotConfirmationResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 128,
      system:
        "El cliente está respondiendo a una lista de horarios propuestos para una visita. Devolvé el " +
        "índice (0-based) del horario que eligió, o null si el mensaje no elige ninguno de los " +
        "propuestos (pide otro horario, cancela, es ambiguo). Nunca inventes un índice fuera de rango.",
      messages: [
        {
          role: "user",
          content: `Horarios propuestos:\n${proposedSlotsLabels.map((s, i) => `${i}: ${s}`).join("\n")}\n\nRespuesta del cliente: "${message}"`,
        },
      ],
      tools: [
        {
          name: TOOL_NAME,
          description: "Devuelve el índice del horario elegido, o null si no matchea ninguno.",
          input_schema: {
            type: "object",
            properties: {
              chosen_index: { type: ["integer", "null"] },
            },
            required: ["chosen_index"],
          },
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUse) {
      throw new Error("Claude no devolvió una elección de horario.");
    }
    const input = toolUse.input as { chosen_index: number | null };
    if (
      input.chosen_index === null ||
      input.chosen_index === undefined ||
      input.chosen_index < 0 ||
      input.chosen_index >= proposedSlotsLabels.length
    ) {
      return { chosenIndex: null };
    }
    return { chosenIndex: input.chosen_index };
  }
}
