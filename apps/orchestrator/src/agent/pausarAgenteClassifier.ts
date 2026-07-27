import Anthropic from "@anthropic-ai/sdk";

export interface PausarAgenteAction {
  accion: "pausar" | "reactivar";
  alcance: "conversacion" | "global";
  /** Solo si alcance="conversacion" y el broker mencionó un número explícito — nunca se infiere de un nombre. */
  telefonoCliente?: string;
}

export interface PausarAgenteActionClassifier {
  extractAction(message: string): Promise<PausarAgenteAction>;
}

const TOOL_NAME = "extract_pausar_agente_action";

/** broker_pausar_agente: distingue pausar/reactivar, puntual/global, y el teléfono si el broker lo dio. */
export class ClaudePausarAgenteActionClassifier implements PausarAgenteActionClassifier {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async extractAction(message: string): Promise<PausarAgenteAction> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 128,
      system:
        'El broker le está pidiendo al agente que pause o reactive las respuestas automáticas. Decidí ' +
        '"accion" ("pausar" o "reactivar") y "alcance" ("conversacion" si se refiere a un cliente puntual, ' +
        '"global" si es para todas las conversaciones). Si "alcance" es "conversacion" y el mensaje incluye ' +
        "un número de teléfono del cliente, devolvelo en \"telefono_cliente\" (solo dígitos). Si el broker " +
        'solo dio un nombre ("Juan") sin número, dejá "telefono_cliente" sin completar — nunca inventes un ' +
        "número a partir de un nombre.",
      messages: [{ role: "user", content: `Mensaje del broker: "${message}"` }],
      tools: [
        {
          name: TOOL_NAME,
          description: "Devuelve la acción de pausa/reactivación pedida por el broker.",
          input_schema: {
            type: "object",
            properties: {
              accion: { type: "string", enum: ["pausar", "reactivar"] },
              alcance: { type: "string", enum: ["conversacion", "global"] },
              telefono_cliente: { type: "string" },
            },
            required: ["accion", "alcance"],
          },
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUse) {
      throw new Error("Claude no devolvió la acción de pausar/reactivar el agente.");
    }
    const input = toolUse.input as { accion: "pausar" | "reactivar"; alcance: "conversacion" | "global"; telefono_cliente?: string };
    return { accion: input.accion, alcance: input.alcance, telefonoCliente: input.telefono_cliente };
  }
}
