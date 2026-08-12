// Modo de fallo 1 del pre-mortem: que exista un camino de envío que no pase
// por el filtro. Por eso el filtro vive en el sender y no en el llamador —
// acá se verifica que ninguno de los tres métodos de la interfaz deje pasar
// nada que no vaya al broker.

import { describe, expect, it, vi } from "vitest";
import { SilentModeSender } from "./silentModeSender.js";
import type { WhatsAppSendResult, WhatsAppSender } from "./sender.js";

const BROKER = "5491155551111";
const CLIENTE = "5491133339999";

function senderEspia(): WhatsAppSender & { destinos: string[] } {
  const destinos: string[] = [];
  const ok = async (to: string): Promise<WhatsAppSendResult> => {
    destinos.push(to);
    return { raw: { messaging_product: "whatsapp" } };
  };
  return {
    destinos,
    sendText: vi.fn((to: string) => ok(to)),
    sendImage: vi.fn((to: string) => ok(to)),
    sendTemplate: vi.fn((to: string) => ok(to)),
  };
}

describe("SilentModeSender", () => {
  it("deja pasar los tres tipos de envío cuando el destino es el broker", async () => {
    const interno = senderEspia();
    const sender = new SilentModeSender(interno, BROKER, () => {});

    await sender.sendText(BROKER, "resumen");
    await sender.sendImage(BROKER, "https://x/y.jpg");
    await sender.sendTemplate(BROKER, "plantilla", "es", []);

    expect(interno.destinos).toEqual([BROKER, BROKER, BROKER]);
  });

  it("bloquea los tres tipos de envío cuando el destino es un cliente", async () => {
    const interno = senderEspia();
    const sender = new SilentModeSender(interno, BROKER, () => {});

    await sender.sendText(CLIENTE, "hola");
    await sender.sendImage(CLIENTE, "https://x/y.jpg");
    await sender.sendTemplate(CLIENTE, "recordatorio_visita", "es", ["10:00"]);

    expect(interno.destinos).toEqual([]);
    expect(sender.bloqueadosHastaAhora()).toBe(3);
  });

  // Las plantillas son las de los jobs proactivos (recordatorio, recontacto,
  // seguimiento). Son el camino que más fácil se olvida porque no sale del
  // webhook sino del scheduler.
  it("bloquea las plantillas proactivas de los jobs", async () => {
    const interno = senderEspia();
    const sender = new SilentModeSender(interno, BROKER, () => {});

    await sender.sendTemplate(CLIENTE, "recontacto_lead_frio", "es", ["Juan"]);

    expect(interno.sendTemplate).not.toHaveBeenCalled();
  });

  it("no se confunde por el formato del número del broker", async () => {
    const interno = senderEspia();
    const sender = new SilentModeSender(interno, `+${BROKER}`, () => {});

    await sender.sendText(BROKER, "resumen");

    expect(interno.destinos).toEqual([BROKER]);
  });

  // Falla cerrado: el error de dejar pasar un mensaje a un desconocido no se
  // deshace, el de no mandar ninguno sí.
  it("sin número de broker configurado no sale absolutamente nada", async () => {
    const interno = senderEspia();
    const sender = new SilentModeSender(interno, undefined, () => {});

    await sender.sendText(BROKER, "ni siquiera esto");
    await sender.sendText(CLIENTE, "menos esto");

    expect(interno.destinos).toEqual([]);
  });

  it("no lanza al bloquear: un job no debe interpretarlo como fallo y reintentar", async () => {
    const sender = new SilentModeSender(senderEspia(), BROKER, () => {});

    await expect(sender.sendText(CLIENTE, "hola")).resolves.toMatchObject({
      raw: { messaging_product: "whatsapp" },
    });
  });

  it("si el logueo del bloqueo explota, el envío sigue bloqueado igual", async () => {
    const interno = senderEspia();
    const sender = new SilentModeSender(interno, BROKER, () => {
      throw new Error("logger roto");
    });

    await expect(sender.sendText(CLIENTE, "hola")).resolves.toBeDefined();
    expect(interno.destinos).toEqual([]);
  });

  it("el log enmascara el teléfono del bloqueado", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sender = new SilentModeSender(senderEspia(), BROKER);

    await sender.sendText(CLIENTE, "hola");

    const linea = String(warn.mock.calls[0]?.[0]);
    expect(linea).not.toContain(CLIENTE);
    expect(linea).toContain("9999");
    warn.mockRestore();
  });
});
