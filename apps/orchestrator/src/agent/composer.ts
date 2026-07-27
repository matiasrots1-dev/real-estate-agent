import Anthropic from "@anthropic-ai/sdk";

export interface ComposeInput {
  intentDescription: string;
  /** Únicos datos que el LLM puede usar para redactar — nunca inventa lo que no esté acá. */
  groundingData: Record<string, unknown>;
  language: string;
}

export interface ResponseComposer {
  compose(input: ComposeInput): Promise<string>;
}

/**
 * Redacción final "generative_grounded" (docs/intent_catalog.yaml): el LLM
 * redacta en lenguaje natural, pero únicamente con datos que vinieron de un
 * tool. Nunca se le pasa margen para inventar precio/disponibilidad.
 */
export class ClaudeResponseComposer implements ResponseComposer {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async compose(input: ComposeInput): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 300,
      system:
        `Redactá una respuesta breve de WhatsApp en ${input.language} para un cliente de una ` +
        "inmobiliaria. Usá EXCLUSIVAMENTE los datos provistos en groundingData. Nunca inventes " +
        "precios, direcciones, ni disponibilidad que no estén ahí. Si groundingData indica que no " +
        "se encontró nada, o algún campo viene en null, decilo con naturalidad (\"ese dato no lo " +
        "tengo cargado, te confirmo en breve\") en vez de inventarlo o ignorarlo. Sin saludos " +
        "largos, directo y cordial. " +
        "Formato de WhatsApp real, no Markdown estándar: *negrita* con un solo asterisco (nunca " +
        "**doble**), _cursiva_ con guión bajo simple. Sin encabezados (#), sin listas con guiones ni " +
        "numeradas, sin emojis salvo que aporten algo puntual (máximo uno).",
      messages: [
        {
          role: "user",
          content: `Intent: ${input.intentDescription}\nDatos grounding (JSON): ${JSON.stringify(input.groundingData)}`,
        },
      ],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    if (!textBlock) {
      throw new Error("Claude no devolvió texto para la respuesta.");
    }
    return textBlock.text;
  }
}
