// Envío de mensajes de texto/imagen vía WhatsApp Cloud API (Meta Graph API).
// Interfaz separada de la implementación real para poder testear el resto
// del loop sin pegarle a la API de Meta.

const GRAPH_API_BASE_URL = "https://graph.facebook.com/v21.0";

// Forma de la respuesta 200 de POST /{phone_number_id}/messages. Un 200 acá
// significa "Meta aceptó encolarlo", no "el destinatario lo recibió" — la
// entrega real solo se confirma vía los webhooks de status (delivered/read)
// que este proyecto todavía no procesa.
interface GraphApiSendMessageResponse {
  messaging_product: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
}

export interface WhatsAppSendResult {
  messageId?: string;
  waId?: string;
  raw: GraphApiSendMessageResponse;
}

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<WhatsAppSendResult>;
  /** `imageUrl` debe ser una URL pública (Graph API no acepta rutas locales). */
  sendImage(to: string, imageUrl: string, caption?: string): Promise<WhatsAppSendResult>;
}

export class GraphApiWhatsAppSender implements WhatsAppSender {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  sendText(to: string, body: string): Promise<WhatsAppSendResult> {
    return this.postMessage({ messaging_product: "whatsapp", to, type: "text", text: { body } });
  }

  sendImage(to: string, imageUrl: string, caption?: string): Promise<WhatsAppSendResult> {
    return this.postMessage({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl, caption },
    });
  }

  private async postMessage(body: Record<string, unknown>): Promise<WhatsAppSendResult> {
    const to = body.to as string;
    const res = await this.fetchFn(`${GRAPH_API_BASE_URL}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`WhatsApp Cloud API respondió ${res.status}: ${await res.text()}`);
    }

    const raw = (await res.json()) as GraphApiSendMessageResponse;
    const messageId = raw.messages?.[0]?.id;
    const waId = raw.contacts?.[0]?.wa_id;
    console.log(
      `WhatsApp Cloud API aceptó el mensaje (${body.type}) a ${to}: messageId=${messageId ?? "?"} wa_id=${waId ?? "?"} status=${raw.messages?.[0]?.message_status ?? "?"}`
    );
    return { messageId, waId, raw };
  }
}
