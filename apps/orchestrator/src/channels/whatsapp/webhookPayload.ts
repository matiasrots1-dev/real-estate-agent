// Forma mínima del payload de webhook de WhatsApp Cloud API (Meta) que nos
// interesa: un mensaje de texto entrante. Meta manda mucho más (statuses,
// otros tipos de mensaje) que ignoramos por ahora.
// Ref: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks

import { z } from "zod";

const WhatsAppTextMessageSchema = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});

const WhatsAppWebhookPayloadSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            messages: z.array(z.unknown()).optional(),
          }),
        })
      ),
    })
  ),
});

export interface IncomingWhatsAppMessage {
  from: string;
  messageId: string;
  text: string;
  phoneNumberId?: string;
}

/**
 * Extrae el primer mensaje de texto entrante de un payload de webhook.
 * Devuelve null si el payload no tiene la forma esperada o no trae un
 * mensaje de texto (ej. es un status update, o un tipo de mensaje no
 * soportado todavía).
 */
export function parseIncomingMessage(rawBody: unknown): IncomingWhatsAppMessage | null {
  const payload = WhatsAppWebhookPayloadSchema.safeParse(rawBody);
  if (!payload.success) return null;

  for (const entry of payload.data.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata?.phone_number_id;
      for (const rawMessage of change.value.messages ?? []) {
        const message = WhatsAppTextMessageSchema.safeParse(rawMessage);
        if (message.success) {
          return {
            from: message.data.from,
            messageId: message.data.id,
            text: message.data.text.body,
            phoneNumberId,
          };
        }
      }
    }
  }
  return null;
}
