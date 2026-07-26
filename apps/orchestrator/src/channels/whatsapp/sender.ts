// Envío de mensajes de texto vía WhatsApp Cloud API (Meta Graph API).
// Interfaz separada de la implementación real para poder testear el resto
// del loop sin pegarle a la API de Meta.

const GRAPH_API_BASE_URL = "https://graph.facebook.com/v21.0";

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
}

export class GraphApiWhatsAppSender implements WhatsAppSender {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async sendText(to: string, body: string): Promise<void> {
    const res = await this.fetchFn(`${GRAPH_API_BASE_URL}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });

    if (!res.ok) {
      throw new Error(`WhatsApp Cloud API respondió ${res.status}: ${await res.text()}`);
    }
  }
}
