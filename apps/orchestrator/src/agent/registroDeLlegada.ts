import { randomUUID } from "node:crypto";
import type { AuditLogEntry } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { AuditLogStore } from "./auditLog.js";
import { INTENT_PROCESAMIENTO_FALLIDO, INTENT_SIN_CLASIFICAR } from "./auditPorMensaje.js";

/**
 * El registro de que alguien escribió, independiente de que el procesamiento
 * funcione (docs/TASKS.md Bloque 34).
 *
 * Pasó de verdad el 2026-08-28: se acabó el crédito de la API de Anthropic y
 * los mensajes se evaporaron. El proveedor recibió 200, el error quedó solo en
 * consola, y no hubo entrada en el audit log ni aviso al broker. Decisión del
 * dueño del repo: el registro de que alguien le escribió no puede depender de
 * que la API de Anthropic funcione.
 *
 * Las dos funciones son best-effort y **nunca tiran** (modo de fallo 3 del
 * pre-mortem). Si la escritura de "llegó" tumbara el mensaje, el bloque dejaría
 * las cosas peor que antes, cuando al menos el camino feliz funcionaba.
 */

/** Se escribe apenas llega el mensaje, antes de clasificar. */
export async function registrarRecibido(
  auditLog: AuditLogStore | undefined,
  message: IncomingWhatsAppMessage,
  ahora: Date = new Date()
): Promise<boolean> {
  return escribir(auditLog, {
    ...base(message, ahora),
    matchedIntentId: INTENT_SIN_CLASIFICAR,
    escalatedToBroker: false,
    etapa: "recibido",
  });
}

/**
 * Se escribe cuando el procesamiento tiró. Queda como escalado porque es del
 * broker: nadie le contestó al cliente. El aviso sale por otro camino
 * (`AvisoDeFallos`, que no pasa por Claude) y se escribe DESPUÉS de esta
 * entrada, así que acá no se afirma que llegó: puede no salir (sin número del
 * broker, WhatsApp caído) o quedar en un resumen que se pierde si el proceso
 * se reinicia.
 */
export async function registrarFallido(
  auditLog: AuditLogStore | undefined,
  message: IncomingWhatsAppMessage,
  error: unknown,
  ahora: Date = new Date()
): Promise<boolean> {
  return escribir(auditLog, {
    ...base(message, ahora),
    matchedIntentId: INTENT_PROCESAMIENTO_FALLIDO,
    escalatedToBroker: true,
    escalationReason:
      `Falló el procesamiento: ${describirError(error)}. Al cliente no se le respondió nada.`,
    etapa: "fallido",
  });
}

/** Una línea legible del error, recortada: va al audit log, no un stack entero. */
export function describirError(error: unknown): string {
  const texto = error instanceof Error ? error.message : String(error);
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (!limpio) return "error sin mensaje";
  return limpio.length > 200 ? `${limpio.slice(0, 200)}…` : limpio;
}

function base(message: IncomingWhatsAppMessage, ahora: Date) {
  return {
    id: randomUUID(),
    conversationId: message.from,
    timestamp: ahora.toISOString(),
    incomingMessage: message.text,
    confidence: null,
    toolsCalled: [] as string[],
    messageId: message.messageId,
  };
}

async function escribir(auditLog: AuditLogStore | undefined, entrada: AuditLogEntry): Promise<boolean> {
  // Sin audit log configurado no hay dónde registrar, y eso no es un error del
  // mensaje: pasa en tests del webhook que no ejercitan la auditoría.
  if (!auditLog) return false;
  try {
    await auditLog.append(entrada);
    return true;
  } catch (error) {
    console.error(
      `[audit] no se pudo registrar la etapa "${entrada.etapa}" del mensaje de ${entrada.conversationId}:`,
      error
    );
    return false;
  }
}
