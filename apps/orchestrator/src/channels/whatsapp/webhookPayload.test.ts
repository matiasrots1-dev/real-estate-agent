import { describe, expect, it } from "vitest";
import { parseIncomingMessage } from "./webhookPayload.js";

function metaPayload(messages: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "111222333" },
              messages,
            },
          },
        ],
      },
    ],
  };
}

describe("parseIncomingMessage", () => {
  it("extrae un mensaje de texto entrante", () => {
    const payload = metaPayload([
      {
        from: "5491100000001",
        id: "wamid.abc",
        timestamp: "1700000000",
        type: "text",
        text: { body: "¿el depto de Palermo sigue disponible?" },
      },
    ]);

    const message = parseIncomingMessage(payload);

    expect(message).toEqual({
      from: "5491100000001",
      messageId: "wamid.abc",
      text: "¿el depto de Palermo sigue disponible?",
      phoneNumberId: "111222333",
    });
  });

  it("devuelve null si no hay mensajes (ej. un status update)", () => {
    const payload = metaPayload([]);
    expect(parseIncomingMessage(payload)).toBeNull();
  });

  it("devuelve null si el mensaje no es de tipo texto", () => {
    const payload = metaPayload([
      { from: "5491100000001", id: "wamid.abc", timestamp: "1700000000", type: "image" },
    ]);
    expect(parseIncomingMessage(payload)).toBeNull();
  });

  it("devuelve null ante un payload con forma inesperada, sin tirar excepción", () => {
    expect(parseIncomingMessage({ algo: "random" })).toBeNull();
    expect(parseIncomingMessage(null)).toBeNull();
    expect(parseIncomingMessage("no es un objeto")).toBeNull();
  });
});
