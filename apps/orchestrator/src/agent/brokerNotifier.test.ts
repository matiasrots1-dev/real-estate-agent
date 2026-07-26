import { describe, expect, it, vi } from "vitest";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import { WhatsAppBrokerNotifier, formatBrokerNotificationText, type BrokerNotification } from "./brokerNotifier.js";

const notification: BrokerNotification = {
  conversationId: "5491100000001",
  incomingMessage: "esto es un desastre, nadie me atiende",
  matchedIntentId: "reclamo_queja",
  confidence: 0.91,
  escalationReason: "No usar respuesta genérica frente a disconformidad.",
  draftReply: "Hola! Disculpá la demora, ¿me contás qué pasó para ayudarte?",
};

describe("formatBrokerNotificationText", () => {
  it("incluye intent, confianza, mensaje del cliente, motivo y borrador", () => {
    const text = formatBrokerNotificationText(notification);
    expect(text).toContain("reclamo_queja");
    expect(text).toContain("91%");
    expect(text).toContain("5491100000001");
    expect(text).toContain(notification.incomingMessage);
    expect(text).toContain(notification.escalationReason as string);
    expect(text).toContain(notification.draftReply);
  });

  it("omite la línea de motivo si no hay escalationReason", () => {
    const text = formatBrokerNotificationText({ ...notification, escalationReason: undefined });
    expect(text).not.toContain("Motivo:");
  });
});

describe("WhatsAppBrokerNotifier", () => {
  it("manda el texto formateado al número del broker", async () => {
    const sendText = vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } }));
    const sender: WhatsAppSender = { sendText };
    const notifier = new WhatsAppBrokerNotifier(sender, "5491199999999");

    await notifier.notify(notification);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [to, body] = sendText.mock.calls[0];
    expect(to).toBe("5491199999999");
    expect(body).toContain("reclamo_queja");
    expect(body).toContain(notification.draftReply);
  });
});
