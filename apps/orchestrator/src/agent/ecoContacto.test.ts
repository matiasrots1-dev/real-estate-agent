import { describe, expect, it } from "vitest";
import { extraerContactosSalientes } from "../channels/whatsapp/ecoContacto.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  contactoDelBroker,
  FileUltimoContactoStore,
  InMemoryUltimoContactoStore,
} from "./ultimoContactoStore.js";

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

  // docs/TASKS.md Bloque 38f. Que el broker haya contestado es lo único que
  // le devuelve la palabra al agente cuando se calló por el Bloque 31. Antes
  // esa señal vivía en `origen`, y el primer contacto del sistema la borraba:
  // el día que se cablee el recontacto del Bloque 27, esa persona se quedaba
  // sin respuesta hasta el techo de los 7 días.
  describe("el contacto del broker no se pierde", () => {
    it("un contacto del sistema posterior no borra el del broker", async () => {
      const store = new InMemoryUltimoContactoStore();

      await store.registrar("lead-1", new Date("2026-08-01"), "manual");
      await store.registrar("lead-1", new Date("2026-08-05"), "sistema");

      const registro = await store.get("lead-1");
      // El último contacto avanza —es lo que mira el recontacto—, pero la
      // fecha en que contestó el broker queda.
      expect(registro?.contactadoAt).toBe(new Date("2026-08-05").toISOString());
      expect(registro?.origen).toBe("sistema");
      expect(contactoDelBroker(registro)).toBe(new Date("2026-08-01").getTime());
    });

    it("un registro anterior al bloque, sin `manualAt`, cuenta por su origen", async () => {
      const viejo = {
        leadId: "lead-1",
        contactadoAt: "2026-08-01T00:00:00.000Z",
        origen: "manual" as const,
      };
      expect(contactoDelBroker(viejo)).toBe(new Date("2026-08-01").getTime());
      expect(contactoDelBroker({ ...viejo, origen: "sistema" })).toBeNull();
    });

    it("un eco del broker que llega tarde igual deja la marca", async () => {
      const store = new InMemoryUltimoContactoStore();

      await store.registrar("lead-1", new Date("2026-08-05"), "sistema");
      await store.registrar("lead-1", new Date("2026-08-01"), "manual");

      const registro = await store.get("lead-1");
      expect(registro?.contactadoAt).toBe(new Date("2026-08-05").toISOString());
      expect(contactoDelBroker(registro)).toBe(new Date("2026-08-01").getTime());
    });

    it("la marca del broker tampoco retrocede", async () => {
      const store = new InMemoryUltimoContactoStore();

      await store.registrar("lead-1", new Date("2026-08-05"), "manual");
      await store.registrar("lead-1", new Date("2026-08-01"), "manual");

      expect(contactoDelBroker(await store.get("lead-1"))).toBe(new Date("2026-08-05").getTime());
    });

    // El eco arma la fecha con el timestamp de Meta: uno absurdo
    // (`new Date(1e20)`) da una fecha inválida, y escribirla dejaría el
    // registro con un `contactadoAt` que ninguna comparación puede ordenar.
    it("una fecha inválida no se registra ni rompe nada", async () => {
      const store = new InMemoryUltimoContactoStore();

      await store.registrar("lead-1", new Date("2026-08-01"), "manual");
      await store.registrar("lead-1", new Date(1e20), "manual");

      expect((await store.get("lead-1"))?.contactadoAt).toBe(new Date("2026-08-01").toISOString());
    });

    it("un lead nuevo con una fecha inválida no queda a medio escribir", async () => {
      const store = new InMemoryUltimoContactoStore();
      await store.registrar("lead-1", new Date(1e20), "manual");
      expect(await store.get("lead-1")).toBeNull();
    });

    // Nada de este módulo escribe una fecha ilegible (ver el test de arriba),
    // pero si una quedó en el archivo —una escritura a medias, una edición a
    // mano— el registro no se puede volver a comparar con nada: sin esto se
    // congela para siempre y ese lead nunca vuelve a contar como contactado.
    it("un `contactadoAt` ilegible se repara con el próximo contacto", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ultimo-contacto-test-"));
      try {
        const archivo = path.join(dir, "ultimo_contacto.json");
        await writeFile(
          archivo,
          JSON.stringify({ "lead-1": { leadId: "lead-1", contactadoAt: "basura", origen: "manual" } })
        );
        const store = new FileUltimoContactoStore(archivo);

        await store.registrar("lead-1", new Date("2026-08-01"), "manual");

        expect((await store.get("lead-1"))?.contactadoAt).toBe(new Date("2026-08-01").toISOString());
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("un lead que sólo contactó el sistema no tiene marca del broker", async () => {
      const store = new InMemoryUltimoContactoStore();
      await store.registrar("lead-1", new Date("2026-08-01"), "sistema");
      expect(contactoDelBroker(await store.get("lead-1"))).toBeNull();
    });
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
