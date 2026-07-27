import Anthropic from "@anthropic-ai/sdk";

export interface ReprogramAction {
  accion: "cancelar" | "reprogramar";
}

export interface ReprogramActionClassifier {
  extractAction(message: string): Promise<ReprogramAction>;
}

const TOOL_NAME = "extract_reprogram_action";

/** reprogramar_cancelar_visita: el mismo intent cubre cancelar o reprogramar — hay que distinguir cuál. */
export class ClaudeReprogramActionClassifier implements ReprogramActionClassifier {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async extractAction(message: string): Promise<ReprogramAction> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 64,
      system:
        'El cliente quiere cambiar algo de una visita ya agendada. Decidí si quiere "cancelar" ' +
        '(no quiere ir más) o "reprogramar" (quiere otro horario). Si es ambiguo, asumí "reprogramar".',
      messages: [{ role: "user", content: `Mensaje del cliente: "${message}"` }],
      tools: [
        {
          name: TOOL_NAME,
          description: 'Devuelve "cancelar" o "reprogramar".',
          input_schema: {
            type: "object",
            properties: {
              accion: { type: "string", enum: ["cancelar", "reprogramar"] },
            },
            required: ["accion"],
          },
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUse) {
      throw new Error("Claude no devolvió la acción de reprogramar/cancelar.");
    }
    return toolUse.input as ReprogramAction;
  }
}
