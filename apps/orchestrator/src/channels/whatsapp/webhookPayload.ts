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
const DescriptorSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string().optional(),
              value: z
                .object({
                  statuses: z.array(z.unknown()).optional(),
                  messages: z.array(z.object({ type: z.string().optional() }).passthrough()).optional(),
                })
                .passthrough()
                .optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),
});

/**
 * Etiqueta corta de POR QUÉ un payload no produjo un mensaje procesable.
 *
 * Sólo se llama cuando `parseIncomingMessage` devolvió null, y es
 * deliberadamente **aditiva**: no toca el camino de parseo real, así que no
 * puede romper el procesamiento de un mensaje bueno. Su única función es que
 * el contador pueda distinguir "me llegaron 30 statuses" de "me llegaron 30
 * mensajes de un tipo que no soporto", que son problemas opuestos.
 *
 * Nunca devuelve contenido del mensaje: sólo la forma del payload.
 */
export function describirPayloadSinMensaje(rawBody: unknown): string {
  const parsed = DescriptorSchema.safeParse(rawBody);
  if (!parsed.success || !parsed.data.entry) return "payload_no_reconocido";

  const tipos: string[] = [];
  let huboStatuses = false;
  let huboChanges = false;

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes ?? []) {
      huboChanges = true;
      if (change.value?.statuses?.length) huboStatuses = true;
      for (const mensaje of change.value?.messages ?? []) {
        tipos.push(mensaje.type ?? "sin_tipo");
      }
    }
  }

  if (tipos.length > 0) return `mensaje_tipo:${[...new Set(tipos)].sort().join("+")}`;
  if (huboStatuses) return "status";
  if (huboChanges) return "change_sin_mensajes_ni_status";
  return "entry_vacio";
}

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
