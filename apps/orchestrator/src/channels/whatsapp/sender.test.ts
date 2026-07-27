import { describe, expect, it, vi } from "vitest";
import { GraphApiWhatsAppSender } from "./sender.js";

function fakeGraphApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    messaging_product: "whatsapp",
    contacts: [{ input: "5491100000001", wa_id: "5491100000001" }],
    messages: [{ id: "wamid.test123", message_status: "accepted" }],
    ...overrides,
  };
}

describe("GraphApiWhatsAppSender", () => {
  it("sendText arma el body de tipo text y parsea messageId/waId", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/123456/messages");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ messaging_product: "whatsapp", to: "5491100000001", type: "text", text: { body: "hola" } });
      return new Response(JSON.stringify(fakeGraphApiResponse()), { status: 200 });
    });

    const sender = new GraphApiWhatsAppSender("123456", "token-x", fakeFetch as unknown as typeof fetch);
    const result = await sender.sendText("5491100000001", "hola");

    expect(result.messageId).toBe("wamid.test123");
    expect(result.waId).toBe("5491100000001");
  });

  it("sendImage arma el body de tipo image con link y caption opcional", async () => {
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        messaging_product: "whatsapp",
        to: "5491100000001",
        type: "image",
        image: { link: "https://example.com/foto.jpg", caption: "Depto Palermo" },
      });
      return new Response(JSON.stringify(fakeGraphApiResponse()), { status: 200 });
    });

    const sender = new GraphApiWhatsAppSender("123456", "token-x", fakeFetch as unknown as typeof fetch);
    await sender.sendImage("5491100000001", "https://example.com/foto.jpg", "Depto Palermo");
  });

  it("sendTemplate arma components con los bodyParams en orden", async () => {
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        messaging_product: "whatsapp",
        to: "5491100000001",
        type: "template",
        template: {
          name: "recordatorio_visita_v1",
          language: { code: "es_AR" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Depto Palermo" },
                { type: "text", text: "lunes 27-7, 10:00" },
                { type: "text", text: "16°C, lluvia ligera" },
              ],
            },
          ],
        },
      });
      return new Response(JSON.stringify(fakeGraphApiResponse()), { status: 200 });
    });

    const sender = new GraphApiWhatsAppSender("123456", "token-x", fakeFetch as unknown as typeof fetch);
    await sender.sendTemplate("5491100000001", "recordatorio_visita_v1", "es_AR", [
      "Depto Palermo",
      "lunes 27-7, 10:00",
      "16°C, lluvia ligera",
    ]);
  });

  it("sendTemplate omite components si no hay bodyParams", async () => {
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.template.components).toBeUndefined();
      return new Response(JSON.stringify(fakeGraphApiResponse()), { status: 200 });
    });

    const sender = new GraphApiWhatsAppSender("123456", "token-x", fakeFetch as unknown as typeof fetch);
    await sender.sendTemplate("5491100000001", "hello_world", "es_AR", []);
  });

  it("propaga un error legible si la API responde con error", async () => {
    const fakeFetch = vi.fn(async () => new Response("token inválido", { status: 401 }));
    const sender = new GraphApiWhatsAppSender("123456", "token-malo", fakeFetch as unknown as typeof fetch);

    await expect(sender.sendText("5491100000001", "hola")).rejects.toThrow(/WhatsApp Cloud API respondió 401/);
  });
});
