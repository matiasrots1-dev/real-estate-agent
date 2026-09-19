import type { WhatsAppSender } from "../channels/whatsapp/sender.js";

export interface BrokerNotification {
  conversationId: string;
  incomingMessage: string;
  matchedIntentId: string;
  /** `null` cuando el escalamiento surge de una continuación multi-turno (agendar/reprogramar visita), sin clasificación este turno. */
  confidence: number | null;
  escalationReason?: string;
  /**
   * `null` cuando el borrador no se pudo redactar (docs/TASKS.md Bloque 38a):
   * el aviso sale igual, sin borrador. Antes, si fallaba el borrador, no
   * salía nada.
   */
  draftReply: string | null;
  /** Por qué no hay borrador, en una línea. Solo con `draftReply: null`. */
  motivoSinBorrador?: string;
}

export interface BrokerNotifier {
  notify(notification: BrokerNotification): Promise<void>;
}

/** Texto plano del mensaje que recibe el broker (docs/escalation_policy.md paso 2). */
export function formatBrokerNotificationText(n: BrokerNotification): string {
  const lines = [
    `🔔 Escalamiento: *${n.matchedIntentId}*`,
    `De: ${n.conversationId}`,
    `Confianza: ${n.confidence === null ? "N/A (continuación de conversación)" : `${Math.round(n.confidence * 100)}%`}`,
  ];
  if (n.escalationReason) lines.push(`Motivo: ${n.escalationReason}`);
  lines.push("", `Mensaje del cliente:`, `"${n.incomingMessage}"`);
  if (n.draftReply === null) {
    // Explícito, para que no se lea como "el bot no tenía nada que sugerir".
    const motivo = n.motivoSinBorrador ? ` (${n.motivoSinBorrador})` : "";
    lines.push("", `⚠️ Sin borrador: no se pudo redactar${motivo}. Contestale vos.`);
  } else {
    lines.push("", `Borrador sugerido (revisar antes de mandar):`, n.draftReply);
  }
  return lines.join("\n");
}

export class WhatsAppBrokerNotifier implements BrokerNotifier {
  constructor(
    private readonly sender: WhatsAppSender,
    private readonly brokerWhatsappNumber: string
  ) {}

  async notify(notification: BrokerNotification): Promise<void> {
    await this.sender.sendText(this.brokerWhatsappNumber, formatBrokerNotificationText(notification));
  }
}
