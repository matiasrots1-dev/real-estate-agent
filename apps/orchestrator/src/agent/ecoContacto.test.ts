import { describe, expect, it } from "vitest";
import { extraerContactosSalientes } from "../channels/whatsapp/ecoContacto.js";
import { InMemoryUltimoContactoStore } from "./ultimoContactoStore.js";

function eco(echoes: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: echoes } }] }],
  };
}

describe("extraer el contacto saliente del eco", () => {
  it("saca el destinatario y la fecha", () => {
    const r = extraerContactosSalientes(
      eco([{ from: "5491155551111", to: "5491133339999", id: "wamid.x", timestamp: "1756000000", type: "text", text: { body: "hola" } }])
    );

    expect(r).toHaveLength(1);
    expect(r[0]?.telefono).toBe("5491133339999");
    expect(r[0]?.cuando.getTime()).toBe(1756000000 * 1000);
  });

  // El texto se devuelve PARA QUE EL LLAMADOR LO ANONIMICE, no para guardarlo.
  // Que nunca se persista en crudo se verifica en webhookEco.test.ts, que es
  // donde ocurre la escritura.
  it("devuelve el texto para que el llamador lo anonimice", () => {
    const r = extraerContactosSalientes(
      eco([{ to: "5491133339999", timestamp: "1756000000", type: "text", text: { body: "algo que dijo" } }])
    );

    expect(r[0]?.texto).toBe("algo que dijo");
  });

  it("sin texto (revoke, imagen) el campo queda ausente, no vacío", () => {
    const r = extraerContactosSalientes(
      eco([{ to: "5491133339999", timestamp: "1756000000", type: "revoke", original_message_id: "wamid.y" }])
    );

    expect(r[0]?.texto).toBeUndefined();
  });

  it("un revoke cuenta como contacto igual", () => {
    // El broker borró el mensaje, pero la persona ya lo pudo ver. Suprimir de
    // más es el lado seguro de este error.
    const r = extraerContactosSalientes(
      eco([{ to: "5491133339999", timestamp: "1756000000", type: "revoke", original_message_id: "wamid.y" }])
    );

    expect(r).toHaveLength(1);
  });

  it("varios destinatarios en un mismo eco", () => {
    const r = extraerContactosSalientes(
      eco([
        { to: "5491133339999", timestamp: "1756000000", type: "text" },
        { to: "5491144448888", timestamp: "1756000100", type: "text" },
      ])
    );

    expect(r.map((c) => c.telefono)).toEqual(["5491133339999", "5491144448888"]);
  });

  it("ignora ecos sin destinatario en vez de romper", () => {
    expect(extraerContactosSalientes(eco([{ timestamp: "1756000000" }]))).toEqual([]);
  });

  it("un payload que no es un eco devuelve vacío", () => {
    expect(extraerContactosSalientes({ object: "whatsapp_business_account", entry: [] })).toEqual([]);
    expect(extraerContactosSalientes(null)).toEqual([]);
    expect(extraerContactosSalientes({ cualquier: "cosa" })).toEqual([]);
  });
});

describe("registro de último contacto", () => {
  it("guarda el contacto manual y el del sistema en el mismo lugar", async () => {
    const store = new InMemoryUltimoContactoStore();

    await store.registrar("lead-1", new Date("2026-06-01"), "manual");
    await store.registrar("lead-2", new Date("2026-06-02"), "sistema");

    expect((await store.get("lead-1"))?.origen).toBe("manual");
    expect((await store.get("lead-2"))?.origen).toBe("sistema");
  });

  // Un eco que llega tarde o desordenado no puede rejuvenecer el registro y
  // habilitar un recontacto que no corresponde.
  it("es monótono: no retrocede la fecha", async () => {
    const store = new InMemoryUltimoContactoStore();

    await store.registrar("lead-1", new Date("2026-08-01"), "manual");
    await store.registrar("lead-1", new Date("2026-06-01"), "manual");

    expect((await store.get("lead-1"))?.contactadoAt).toBe(new Date("2026-08-01").toISOString());
  });

  it("sí avanza hacia adelante", async () => {
    const store = new InMemoryUltimoContactoStore();

    await store.registrar("lead-1", new Date("2026-06-01"), "sistema");
    await store.registrar("lead-1", new Date("2026-08-01"), "manual");

    expect((await store.get("lead-1"))?.origen).toBe("manual");
  });

  describe("queda dentro de la política de retención", () => {
    it("purga por lead vencido", async () => {
      const store = new InMemoryUltimoContactoStore();
      await store.registrar("lead-1", new Date("2024-01-01"), "manual");
      await store.registrar("lead-2", new Date("2026-08-01"), "manual");

      const r = await store.purgeLeads(new Set(["lead-1", "lead-2"]), new Date("2025-01-01"), false);

      expect(r.borrados).toBe(1);
      expect(await store.get("lead-1")).toBeNull();
      expect(await store.get("lead-2")).not.toBeNull();
    });

    it("en simulacro no borra", async () => {
      const store = new InMemoryUltimoContactoStore();
      await store.registrar("lead-1", new Date("2024-01-01"), "manual");

      const r = await store.purgeLeads(new Set(["lead-1"]), new Date("2025-01-01"), true);

      expect(r.borrados).toBe(1);
      expect(await store.get("lead-1")).not.toBeNull();
    });
  });
});
