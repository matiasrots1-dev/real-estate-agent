import Anthropic from "@anthropic-ai/sdk";

export interface DraftReplyComposer {
  composeDraft(clientMessage: string, intentDescription: string): Promise<string>;
}

/**
 * Borrador de respuesta para que el broker revise antes de mandarlo
 * (docs/escalation_policy.md paso 2). A diferencia de `ResponseComposer`
 * (composer.ts), acá NO hay grounding_fields de un tool — es una sugerencia
 * de un humano para un humano, así que el LLM tiene más libertad, pero se
 * le pide marcar explícitamente lo que no puede confirmar en vez de
 * inventarlo, porque este texto puede terminar reenviado casi tal cual.
 */
export class ClaudeDraftReplyComposer implements DraftReplyComposer {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = "claude-sonnet-4-6"
  ) {}

  async composeDraft(clientMessage: string, intentDescription: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 300,
      system:
        "Redactás un BORRADOR de respuesta de WhatsApp para que un broker inmobiliario humano lo " +
        "revise, edite o descarte antes de mandarlo — nunca se envía tal cual al cliente. Tono " +
        "cordial, breve, español rioplatense. Si el borrador necesitaría un dato que no tenés " +
        "(precio, condición, disponibilidad puntual), escribí [CONFIRMAR: qué dato] en vez de " +
        "inventarlo. Formato WhatsApp real: *negrita* con un asterisco simple, sin Markdown estándar.",
      messages: [
        {
          role: "user",
          content: `Intent detectado: ${intentDescription}\nMensaje del cliente: "${clientMessage}"\n\nRedactá el borrador.`,
        },
      ],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    if (!textBlock) {
      throw new Error("Claude no devolvió un borrador de respuesta.");
    }
    return textBlock.text;
  }
}
