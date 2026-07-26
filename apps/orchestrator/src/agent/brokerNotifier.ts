import type { WhatsAppSender } from "../channels/whatsapp/sender.js";

export interface BrokerNotification {
  conversationId: string;
  incomingMessage: string;
  matchedIntentId: string;
  confidence: number;
  escalationReason?: string;
  draftReply: string;
}

export interface BrokerNotifier {
  notify(notification: BrokerNotification): Promise<void>;
}

/** Texto plano del mensaje que recibe el broker (docs/escalation_policy.md paso 2). */
export function formatBrokerNotificationText(n: BrokerNotification): string {
  const lines = [
    `🔔 Escalamiento: *${n.matchedIntentId}*`,
    `De: ${n.conversationId}`,
    `Confianza: ${Math.round(n.confidence * 100)}%`,
  ];
  if (n.escalationReason) lines.push(`Motivo: ${n.escalationReason}`);
  lines.push("", `Mensaje del cliente:`, `"${n.incomingMessage}"`);
  lines.push("", `Borrador sugerido (revisar antes de mandar):`, n.draftReply);
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
