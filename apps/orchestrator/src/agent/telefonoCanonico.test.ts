import { describe, expect, it, vi } from "vitest";
import { InMemoryTelefonoCanonicoStore } from "./telefonoCanonicoStore.js";
import { CanonicalizingSender } from "../channels/whatsapp/canonicalizingSender.js";
import type { WhatsAppSendResult, WhatsAppSender } from "../channels/whatsapp/sender.js";

/** Simula a Meta: acepta cualquier destino y responde con SU id canónico. */
function senderQueResponde(waId?: string): WhatsAppSender & { destinos: string[] } {
  const destinos: string[] = [];
  const r = async (to: string): Promise<WhatsAppSendResult> => {
    destinos.push(to);
    return { waId, raw: { messaging_product: "whatsapp" } };
  };
  return {
    destinos,
    sendText: vi.fn((to: string) => r(to)),
    sendImage: vi.fn((to: string) => r(to)),
    sendTemplate: vi.fn((to: string) => r(to)),
  };
}

const VIEJO = "54111155559999"; // formato doméstico con 15
const CANONICO = "5491155559999"; // lo que Meta responde como wa_id

describe("aprender el canónico que devuelve Meta", () => {
  it("persiste el wa_id cuando difiere de lo que mandamos", async () => {
    const store = new InMemoryTelefonoCanonicoStore();
    const sender = new CanonicalizingSender(senderQueResponde(CANONICO), store);

    await sender.sendText(VIEJO, "hola");

    expect(await store.get(VIEJO)).toBe(CANONICO);
  });

  it("no guarda nada si Meta confirma el mismo número", async () => {
    const store = new InMemoryTelefonoCanonicoStore();
    const sender = new CanonicalizingSender(senderQueResponde(CANONICO), store);

    await sender.sendText(CANONICO, "hola");

    expect(await store.all()).toEqual([]);
  });

  it("no guarda nada si Meta no devuelve wa_id", async () => {
    const store = new InMemoryTelefonoCanonicoStore();
    const sender = new CanonicalizingSender(senderQueResponde(undefined), store);

    await sender.sendText(VIEJO, "hola");

    expect(await store.all()).toEqual([]);
  });

  // Esto es lo que hace que no se recalcule mal en la próxima corrida.
  it("el segundo envío ya sale al canónico, sin volver a normalizar", async () => {
    const store = new InMemoryTelefonoCanonicoStore();
    const interno = senderQueResponde(CANONICO);
    const sender = new CanonicalizingSender(interno, store);

    await sender.sendText(VIEJO, "primero");
    await sender.sendText(VIEJO, "segundo");

    expect(interno.destinos).toEqual([VIEJO, CANONICO]);
  });

  it("aplica el canónico también a imágenes y plantillas", async () => {
    const store = new InMemoryTelefonoCanonicoStore();
    await store.registrar(VIEJO, CANONICO);
    const interno = senderQueResponde(CANONICO);
    const sender = new CanonicalizingSender(interno, store);

    await sender.sendImage(VIEJO, "https://x/y.jpg");
    await sender.sendTemplate(VIEJO, "recordatorio", "es", []);

    expect(interno.destinos).toEqual([CANONICO, CANONICO]);
  });

  describe("el store nunca puede impedir un envío", () => {
    it("si falla la lectura, se manda con el número original", async () => {
      const roto = {
        get: vi.fn(async () => { throw new Error("disco roto"); }),
        registrar: vi.fn(async () => {}),
        all: vi.fn(async () => []),
        purgeOlderThan: vi.fn(),
      };
      const interno = senderQueResponde(CANONICO);
      const sender = new CanonicalizingSender(interno, roto as never);

      await expect(sender.sendText(VIEJO, "hola")).resolves.toBeDefined();
      expect(interno.destinos).toEqual([VIEJO]);
    });

    it("si falla la escritura, el envío igual se completa", async () => {
      const roto = {
        get: vi.fn(async () => null),
        registrar: vi.fn(async () => { throw new Error("disco lleno"); }),
        all: vi.fn(async () => []),
        purgeOlderThan: vi.fn(),
      };
      const sender = new CanonicalizingSender(senderQueResponde(CANONICO), roto as never);

      await expect(sender.sendText(VIEJO, "hola")).resolves.toBeDefined();
    });
  });

  // Modo de fallo 3 del pre-mortem: es un archivo con teléfonos, o sea datos
  // personales. Nace bajo la política de retención, no fuera de ella.
  describe("queda dentro de la política de retención", () => {
    it("purga los registros más viejos que el corte", async () => {
      const store = new InMemoryTelefonoCanonicoStore();
      await store.registrar("5491100000001", "5491100000001", new Date("2024-01-01"));
      await store.registrar("5491100000002", "5491100000002", new Date("2026-08-01"));

      const r = await store.purgeOlderThan(new Date("2025-01-01"), false);

      expect(r.borrados).toBe(1);
      expect((await store.all()).length).toBe(1);
    });

    it("en simulacro reporta pero no borra", async () => {
      const store = new InMemoryTelefonoCanonicoStore();
      await store.registrar("5491100000001", "5491100000001", new Date("2024-01-01"));

      const r = await store.purgeOlderThan(new Date("2025-01-01"), true);

      expect(r.borrados).toBe(1);
      expect((await store.all()).length).toBe(1);
    });

    it("la muestra del purgado no expone teléfonos completos", async () => {
      const store = new InMemoryTelefonoCanonicoStore();
      await store.registrar("5491155559999", "5491155559999", new Date("2024-01-01"));

      const r = await store.purgeOlderThan(new Date("2025-01-01"), true);

      expect(r.muestra[0]?.id).not.toContain("5555");
    });
  });
});
