import type { WhatsAppSender } from "../channels/whatsapp/sender.js";

export interface BrokerNotification {
  conversationId: string;
  incomingMessage: string;
  matchedIntentId: string;
  /** `null` cuando el escalamiento surge de una continuación multi-turno (agendar/reprogramar visita), sin clasificación este turno. */
  confidence: number | null;
  escalationReason?: string;
  /**
   * `null` cuando no hay borrador (docs/TASKS.md Bloque 38a): el aviso sale
   * igual, sin borrador. Antes, si fallaba el borrador, no salía nada.
   */
  draftReply: string | null;
  /**
   * Solo cuando el borrador de Claude falló: por qué, en una línea. Si además
   * hay `draftReply`, ese borrador es el respaldo: la respuesta que el bot
   * habría mandado.
   */
  motivoFalloBorrador?: string;
}

export interface BrokerNotifier {
  notify(notification: BrokerNotification): Promise<void>;
}

/**
 * Topes por parte del aviso. WhatsApp rechaza textos de más de 4096
 * caracteres, y un mensaje largo del cliente más el borrador lo pasaban: el
 * aviso fallaba siempre para ese mensaje (docs/TASKS.md Bloque 38a).
 */
const MAX_MENSAJE = 1500;
const MAX_BORRADOR = 1500;
const MAX_MOTIVO = 400;

function recortar(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max)}… [recortado]` : texto;
}

/** Texto plano del mensaje que recibe el broker (docs/escalation_policy.md paso 2). */
export function formatBrokerNotificationText(n: BrokerNotification): string {
  const lines = [
    `🔔 Escalamiento: *${n.matchedIntentId}*`,
    `De: ${n.conversationId}`,
    `Confianza: ${n.confidence === null ? "N/A (continuación de conversación)" : `${Math.round(n.confidence * 100)}%`}`,
  ];
  if (n.escalationReason) lines.push(`Motivo: ${recortar(n.escalationReason, MAX_MOTIVO)}`);
  lines.push("", `Mensaje del cliente:`, `"${recortar(n.incomingMessage, MAX_MENSAJE)}"`);
  const falla = n.motivoFalloBorrador ? ` (${recortar(n.motivoFalloBorrador, MAX_MOTIVO)})` : "";
  if (n.draftReply === null) {
    // Explícito, para que no se lea como "el bot no tenía nada que sugerir".
    lines.push("", `⚠️ Sin borrador: no se pudo redactar${falla}. Contestale vos.`);
  } else if (n.motivoFalloBorrador) {
    lines.push(
      "",
      `Borrador: es la respuesta que el bot habría mandado, porque el borrador de Claude falló${falla}. Revisalo antes de mandar:`,
      recortar(n.draftReply, MAX_BORRADOR)
    );
  } else {
    lines.push("", `Borrador sugerido (revisar antes de mandar):`, recortar(n.draftReply, MAX_BORRADOR));
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
