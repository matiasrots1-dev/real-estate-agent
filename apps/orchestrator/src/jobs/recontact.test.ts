import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IntentCatalog, Lead, Property } from "shared-types";
import { loadCatalog } from "../agent/intentCatalog.js";
import { InMemoryAuditLogStore } from "../agent/auditLog.js";
import { InMemoryRecontactStateStore } from "../agent/recontactStateStore.js";
import { InMemoryUltimoContactoStore } from "../agent/ultimoContactoStore.js";
import { InMemoryTopeDiarioStore } from "./topeDiarioStore.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { ResponseComposer } from "../agent/composer.js";
import type { BrokerNotifier, BrokerNotification } from "../agent/brokerNotifier.js";
import { createRecontactJob, type RecontactJobDeps } from "./recontact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));

const propertyOriginal: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
};

function sampleLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    tokkoId: "tokko-lead-1",
    nombre: "Juan Pérez",
    telefonoWhatsapp: "5491100000001",
    temperatura: "frio",
    propiedadesDeInteres: ["prop-1"],
    diasSinRespuesta: 5,
    ...overrides,
  };
}

function recordingBrokerNotifier(): BrokerNotifier & { notifications: BrokerNotification[] } {
  const notifications: BrokerNotification[] = [];
  return {
    notifications,
    notify: vi.fn(async (n: BrokerNotification) => {
      notifications.push(n);
    }),
  };
}

function makeDeps(overrides: Partial<RecontactJobDeps> = {}): RecontactJobDeps & {
  sendTemplate: ReturnType<typeof vi.fn>;
  searchLeads: ReturnType<typeof vi.fn>;
} {
  const sendTemplate = vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } }));
  const sender: WhatsAppSender = { sendText: vi.fn(), sendImage: vi.fn(), sendTemplate };
  const searchLeads = vi.fn(async () => [sampleLead()]);
  const tokko: TokkoQueries = {
    searchProperties: vi.fn(async () => []),
    getProperty: vi.fn(async () => propertyOriginal),
    searchLeads,
    getLead: vi.fn(),
    logActivity: vi.fn(),
  };
  const composer: ResponseComposer = {
    compose: vi.fn(async () => "¡Hola! ¿Seguís buscando? Tenemos novedades."),
  };

  return {
    catalog,
    tokko,
    composer,
    sender,
    recontactStateStore: new InMemoryRecontactStateStore(),
    auditLog: new InMemoryAuditLogStore(),
    ultimoContactoStore: new InMemoryUltimoContactoStore(),
    topeDiarioStore: new InMemoryTopeDiarioStore(),
    // Los tests de acá prueban el envío; el simulacro tiene los suyos.
    envioHabilitado: true,
    // Reloj fijo DENTRO de la ventana horaria de la política (9-20). Sin
    // esto la suite pasaría o fallaría según la hora a la que se corra, que
    // es uno de los modos de fallo que este repo ya sufrió.
    now: () => AHORA,
    sendTemplate,
    searchLeads,
    ...overrides,
  };
}

/** Un martes a las 10 de la mañana, hora local. */
const AHORA = new Date("2026-09-22T10:00:00");

describe("createRecontactJob", () => {
  it("manda el template al lead frío (1er intento, 5 días) y marca el intento", async () => {
    const deps = makeDeps();

    await createRecontactJob(deps).run();

    // `paraRecontacto` no es un detalle: es lo único que hace que el job vea
    // la misma gente que el simulacro que se aprueba. Sin él, le pide a Tokko
    // todos los contactables sobre el umbral —unos 3600— en vez de los 29 que
    // pasan el criterio (docs/TASKS.md Bloque 27).
    expect(deps.searchLeads).toHaveBeenCalledWith({ paraRecontacto: true, diasSinRespuestaMin: 5 });
    expect(deps.sendTemplate).toHaveBeenCalledTimes(1);
    expect(deps.sendTemplate).toHaveBeenCalledWith(
      "5491100000001",
      "recontacto_lead_v1",
      "es_AR",
      ["Juan Pérez", "¡Hola! ¿Seguís buscando? Tenemos novedades."]
    );

    const state = await deps.recontactStateStore.get("lead-1");
    expect(state?.attemptsSent).toEqual(["dias_sin_respuesta >= 5"]);

    const [entry] = await deps.auditLog.readAll();
    expect(entry).toMatchObject({
      conversationId: "5491100000001",
      matchedIntentId: "recontacto_lead_frio",
      escalatedToBroker: false,
    });
  });

  it("no duplica el mismo intento si el job corre de nuevo", async () => {
    const deps = makeDeps();
    await deps.recontactStateStore.save({ leadId: "lead-1", attemptsSent: ["dias_sin_respuesta >= 5"] });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("manda el intento de 15 días aunque ya se haya mandado el de 5", async () => {
    const deps = makeDeps({
      tokko: {
        searchProperties: vi.fn(async () => []),
        getProperty: vi.fn(async () => propertyOriginal),
        searchLeads: vi.fn(async () => [sampleLead({ diasSinRespuesta: 16 })]),
        getLead: vi.fn(),
        logActivity: vi.fn(),
      },
    });
    await deps.recontactStateStore.save({ leadId: "lead-1", attemptsSent: ["dias_sin_respuesta >= 5"] });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledTimes(1);
    const state = await deps.recontactStateStore.get("lead-1");
    expect(state?.attemptsSent).toEqual(["dias_sin_respuesta >= 5", "dias_sin_respuesta >= 15"]);
  });

  it("el 3er intento (30 días) NO se manda directo — va a revisión del broker", async () => {
    const brokerNotifier = recordingBrokerNotifier();
    const deps = makeDeps({
      brokerNotifier,
      tokko: {
        searchProperties: vi.fn(async () => []),
        getProperty: vi.fn(async () => propertyOriginal),
        searchLeads: vi.fn(async () => [sampleLead({ diasSinRespuesta: 31 })]),
        getLead: vi.fn(),
        logActivity: vi.fn(),
      },
    });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
    expect(brokerNotifier.notify).toHaveBeenCalledTimes(1);
    expect(brokerNotifier.notifications[0]).toMatchObject({
      matchedIntentId: "recontacto_lead_frio",
      draftReply: "¡Hola! ¿Seguís buscando? Tenemos novedades.",
    });

    const [entry] = await deps.auditLog.readAll();
    expect(entry.escalatedToBroker).toBe(true);
    expect(entry.escalationRule).toBe("requires_broker");
  });

  it("3er intento sin brokerNotifier configurado: no explota, solo audita", async () => {
    const deps = makeDeps({
      tokko: {
        searchProperties: vi.fn(async () => []),
        getProperty: vi.fn(async () => propertyOriginal),
        searchLeads: vi.fn(async () => [sampleLead({ diasSinRespuesta: 30 })]),
        getLead: vi.fn(),
        logActivity: vi.fn(),
      },
      // brokerNotifier omitido a propósito
    });

    await expect(createRecontactJob(deps).run()).resolves.toBeUndefined();
    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("si la propiedad original ya no está disponible, busca una alternativa del mismo tipo", async () => {
    const alternativa: Property = { ...propertyOriginal, id: "prop-2", direccionCorta: "2 amb. Belgrano" };
    const composeSpy = vi.fn(async () => "respuesta");
    const deps = makeDeps({
      composer: { compose: composeSpy },
      tokko: {
        searchProperties: vi.fn(async () => [alternativa]),
        getProperty: vi.fn(async () => ({ ...propertyOriginal, estado: "alquilada" })),
        searchLeads: vi.fn(async () => [sampleLead()]),
        getLead: vi.fn(),
        logActivity: vi.fn(),
      },
    });

    await createRecontactJob(deps).run();

    expect(composeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        groundingData: { propiedad_original: "Depto Palermo", alternativa: "2 amb. Belgrano" },
      })
    );
  });

  it("si falla el envío de un lead, sigue con los demás", async () => {
    const sendTemplate = vi.fn().mockRejectedValueOnce(new Error("WhatsApp caído"));
    const deps = makeDeps({
      sender: { sendText: vi.fn(), sendImage: vi.fn(), sendTemplate },
      tokko: {
        searchProperties: vi.fn(async () => []),
        getProperty: vi.fn(async () => propertyOriginal),
        searchLeads: vi.fn(async () => [sampleLead({ id: "lead-1" }), sampleLead({ id: "lead-2", telefonoWhatsapp: "5491100000002" })]),
        getLead: vi.fn(),
        logActivity: vi.fn(),
      },
    });

    await expect(createRecontactJob(deps).run()).resolves.toBeUndefined();
    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(await deps.recontactStateStore.get("lead-1")).toBeNull();
    expect((await deps.recontactStateStore.get("lead-2"))?.attemptsSent).toEqual(["dias_sin_respuesta >= 5"]);
  });
});

// docs/TASKS.md Bloque 27. Este es el único job que le escribe a gente que no
// escribió primero, y hasta acá decidía por su cuenta: le pedía a Tokko todos
// los contactables sobre el umbral y les escribía a todos, a cualquier hora,
// sin tope y sin deduplicar. Lo que el dueño del repo aprueba es el simulacro,
// que sí aplica la política — así que aprobaba una cosa y pasaba otra.
describe("createRecontactJob — la política manda", () => {
  const leadCon = (over: Partial<Lead>) => sampleLead(over);

  function conLeads(leads: Lead[], overrides: Partial<RecontactJobDeps> = {}) {
    return makeDeps({
      tokko: {
        searchProperties: vi.fn(async () => []),
        getProperty: vi.fn(async () => propertyOriginal),
        searchLeads: vi.fn(async () => leads),
        getLead: vi.fn(),
        logActivity: vi.fn(),
      },
      ...overrides,
    });
  }

  it("fuera de la ventana horaria no corre ni lee a nadie", async () => {
    // Las 3 de la mañana: la política no deja enviar, y un mensaje a esa hora
    // es lo que separa "un agente" de "un bot".
    const deps = conLeads([sampleLead()], { now: () => new Date("2026-09-22T03:00:00") });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
    expect(deps.searchLeads).not.toHaveBeenCalled();
  });

  it("dos fichas de Tokko con el mismo teléfono reciben UN mensaje", async () => {
    const deps = conLeads([
      leadCon({ id: "lead-1", nombre: "Clara" }),
      leadCon({ id: "lead-2", nombre: "Clara Gómez" }),
    ]);

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("respeta el tope por corrida", async () => {
    const deps = conLeads(
      Array.from({ length: 10 }, (_, i) =>
        leadCon({ id: `lead-${i}`, telefonoWhatsapp: `54911000000${i}` })
      )
    );

    await createRecontactJob(deps).run();

    // CONFIG_POR_DEFECTO.topePorCorrida = 3.
    expect(deps.sendTemplate).toHaveBeenCalledTimes(3);
  });

  it("el tope por día se acuerda de lo que ya salió, aunque el proceso se haya reiniciado", async () => {
    const topeDiarioStore = new InMemoryTopeDiarioStore();
    await topeDiarioStore.sumar(AHORA, 10); // CONFIG_POR_DEFECTO.topePorDia = 10
    const deps = conLeads([sampleLead()], { topeDiarioStore });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("la línea del bot está cargada en el CRM y aun así nunca recibe", async () => {
    const deps = conLeads([leadCon({ telefonoWhatsapp: "5491144445555" })], {
      internos: { contiene: (t: string) => t === "5491144445555" },
    });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("a alguien contactado hace poco no se le escribe, lo haya contactado el sistema o el broker", async () => {
    const ultimoContactoStore = new InMemoryUltimoContactoStore();
    // El eco de coexistencia: el broker le escribió a mano ayer.
    await ultimoContactoStore.registrar("5491100000001", new Date(AHORA.getTime() - 86_400_000), "manual");
    const deps = conLeads([sampleLead()], { ultimoContactoStore });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  // Sin esto, la regla de los 60 días sólo ve lo que el broker escribió a mano
  // y el job no se cuenta a sí mismo: le volvería a escribir a la misma
  // persona en la próxima corrida (docs/TASKS.md Bloques 27 y 38f).
  it("el job se anota a sí mismo como contacto del sistema", async () => {
    const deps = conLeads([sampleLead()]);

    await createRecontactJob(deps).run();

    const registro = await deps.ultimoContactoStore.get("5491100000001");
    expect(registro?.origen).toBe("sistema");
  });

  it("un envío que sale consume el tope del día; uno que falla, no", async () => {
    const sendTemplate = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp caído"))
      .mockResolvedValue({ raw: { messaging_product: "whatsapp" } });
    const topeDiarioStore = new InMemoryTopeDiarioStore();
    const deps = conLeads(
      [
        leadCon({ id: "lead-1", telefonoWhatsapp: "5491100000001" }),
        leadCon({ id: "lead-2", telefonoWhatsapp: "5491100000002" }),
      ],
      { sender: { sendText: vi.fn(), sendImage: vi.fn(), sendTemplate }, topeDiarioStore }
    );

    await createRecontactJob(deps).run();

    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(await topeDiarioStore.enviadosEn(AHORA)).toBe(1);
  });

  // El aviso del 3er intento no le llega al cliente: no puede gastar el cupo
  // de mensajes a clientes.
  it("el aviso al broker del 3er intento no consume el tope diario", async () => {
    const topeDiarioStore = new InMemoryTopeDiarioStore();
    const recontactStateStore = new InMemoryRecontactStateStore();
    await recontactStateStore.save({
      leadId: "lead-1",
      attemptsSent: ["dias_sin_respuesta >= 5", "dias_sin_respuesta >= 15"],
    });
    const brokerNotifier = recordingBrokerNotifier();
    const deps = conLeads([leadCon({ diasSinRespuesta: 40 })], {
      topeDiarioStore,
      recontactStateStore,
      brokerNotifier,
    });

    await createRecontactJob(deps).run();

    expect(brokerNotifier.notifications).toHaveLength(1);
    expect(deps.sendTemplate).not.toHaveBeenCalled();
    expect(await topeDiarioStore.enviadosEn(AHORA)).toBe(0);
  });
});

// Modo de fallo 3 del pre-mortem: un simulacro que toca los stores deja a esa
// gente marcada como contactada sin haberle mandado nada, y al habilitar el
// envío real no se la contacta nunca. Es el mismo error que el modo silencioso
// evita no registrando los jobs.
describe("createRecontactJob — el simulacro no toca nada", () => {
  it("no manda, no marca el intento, no suma al tope y no anota el contacto", async () => {
    const deps = makeDeps({ envioHabilitado: false });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
    expect(await deps.recontactStateStore.get("lead-1")).toBeNull();
    expect(await deps.topeDiarioStore.enviadosEn(AHORA)).toBe(0);
    expect(await deps.ultimoContactoStore.get("5491100000001")).toBeNull();
    expect(await deps.auditLog.readAll()).toHaveLength(0);
  });

  it("tampoco avisa al broker por el 3er intento", async () => {
    const recontactStateStore = new InMemoryRecontactStateStore();
    await recontactStateStore.save({
      leadId: "lead-1",
      attemptsSent: ["dias_sin_respuesta >= 5", "dias_sin_respuesta >= 15"],
    });
    const brokerNotifier = recordingBrokerNotifier();
    const deps = makeDeps({ envioHabilitado: false, recontactStateStore, brokerNotifier });

    await createRecontactJob(deps).run();

    expect(brokerNotifier.notifications).toHaveLength(0);
  });
});

// Los dos casos que el mutation testing mostró sin cubrir (Q8 y Q10).
describe("createRecontactJob — el aviso al broker no es un mensaje a la persona", () => {
  it("haber pedido tu revisión no gasta uno de los dos mensajes permitidos", async () => {
    // Un lead que entra frío a los 40 días recibe primero la revisión (la
    // regla más alta que aplica) y recién después los mensajes de 15 y 5. Con
    // la revisión contada como mensaje llega a los dos permitidos con UNO
    // solo enviado, y el último se suprime por `agotó_intentos` sin que la
    // persona haya recibido las dos cosas que el catálogo define.
    const recontactStateStore = new InMemoryRecontactStateStore();
    await recontactStateStore.save({
      leadId: "lead-1",
      attemptsSent: ["dias_sin_respuesta >= 30", "dias_sin_respuesta >= 15"],
    });
    const deps = makeDeps({
      recontactStateStore,
      tokko: {
        searchProperties: vi.fn(async () => []),
        getProperty: vi.fn(async () => propertyOriginal),
        searchLeads: vi.fn(async () => [sampleLead({ diasSinRespuesta: 40 })]),
        getLead: vi.fn(),
        logActivity: vi.fn(),
      },
    });

    await createRecontactJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledTimes(1);
    expect((await recontactStateStore.get("lead-1"))?.attemptsSent).toEqual([
      "dias_sin_respuesta >= 30",
      "dias_sin_respuesta >= 15",
      "dias_sin_respuesta >= 5",
    ]);
  });

  it("pero los avisos también tienen tope: una cuenta con miles de leads fríos no te vuelca todo de una", async () => {
    const brokerNotifier = recordingBrokerNotifier();
    const deps = makeDeps({
      brokerNotifier,
      tokko: {
        searchProperties: vi.fn(async () => []),
        getProperty: vi.fn(async () => propertyOriginal),
        searchLeads: vi.fn(async () =>
          Array.from({ length: 10 }, (_, i) =>
            sampleLead({ id: `lead-${i}`, telefonoWhatsapp: `54911000000${i}`, diasSinRespuesta: 40 })
          )
        ),
        getLead: vi.fn(),
        logActivity: vi.fn(),
      },
    });

    await createRecontactJob(deps).run();

    // CONFIG_POR_DEFECTO.topePorCorrida = 3.
    expect(brokerNotifier.notifications).toHaveLength(3);
  });
});
