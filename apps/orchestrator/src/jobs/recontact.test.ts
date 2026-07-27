import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IntentCatalog, Lead, Property } from "shared-types";
import { loadCatalog } from "../agent/intentCatalog.js";
import { InMemoryAuditLogStore } from "../agent/auditLog.js";
import { InMemoryRecontactStateStore } from "../agent/recontactStateStore.js";
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
    sendTemplate,
    searchLeads,
    ...overrides,
  };
}

describe("createRecontactJob", () => {
  it("manda el template al lead frío (1er intento, 5 días) y marca el intento", async () => {
    const deps = makeDeps();

    await createRecontactJob(deps).run();

    expect(deps.searchLeads).toHaveBeenCalledWith({ diasSinRespuestaMin: 5 });
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
