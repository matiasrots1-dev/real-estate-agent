// Modo silencioso: el agente recibe, clasifica y le manda SIEMPRE el borrador
// al broker, pero al cliente no le responde nada.
//
// El modo de fallo que más importa acá es el 2 del pre-mortem: que el agente
// calle y el broker tampoco se entere. Sería peor que el problema original —
// el cliente esperando y nadie sabiendo que escribió.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { handleIncomingMessage, type HandleMessageDeps } from "./handleIncomingMessage.js";
import { loadCatalog } from "./intentCatalog.js";
import { InMemoryAuditLogStore } from "./auditLog.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore } from "./conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./globalPauseStore.js";
import { InMemoryLastInteractionStore } from "./lastInteractionStore.js";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { BrokerNotification, BrokerNotifier } from "./brokerNotifier.js";
import type { IntentClassification } from "./classifier.js";
import type { Property } from "shared-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog(path.resolve(__dirname, "../../../..", "docs/intent_catalog.yaml"));

const property: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
  precio: 350000,
  fotos: ["https://example.com/foto1.jpg"],
};

function notifierEspia(): BrokerNotifier & { notificaciones: BrokerNotification[] } {
  const notificaciones: BrokerNotification[] = [];
  return {
    notificaciones,
    notify: vi.fn(async (n: BrokerNotification) => {
      notificaciones.push(n);
    }),
  };
}

function deps(
  clasificacion: IntentClassification,
  overrides: Partial<HandleMessageDeps> = {}
): HandleMessageDeps {
  return {
    catalog,
    classifier: { classify: vi.fn(async () => clasificacion) },
    composer: { compose: vi.fn(async () => "respuesta para el cliente") },
    draftComposer: { composeDraft: vi.fn(async () => "borrador sugerido") },
    tokko: {
      searchProperties: vi.fn(async () => [property]),
      getProperty: vi.fn(async () => property),
      searchLeads: vi.fn(async () => []),
      getLead: vi.fn(async () => null),
      logActivity: vi.fn(async () => ({ logged: true as const, activityId: "act-1" })),
    },
    gcal: {
      freebusy: vi.fn(async () => []),
      createEvent: vi.fn(),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
      getEvent: vi.fn(),
      listEvents: vi.fn(async () => []),
    },
    weather: { getForecast: vi.fn() },
    auditLog: new InMemoryAuditLogStore(),
    appointmentStore: new InMemoryAppointmentStore(),
    conversationStateStore: new InMemoryConversationStateStore(),
    slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: null })) },
    reprogramActionClassifier: { extractAction: vi.fn(async () => ({ accion: "reprogramar" as const })) },
    globalPauseStore: new InMemoryGlobalPauseStore(),
    lastInteractionStore: new InMemoryLastInteractionStore(),
    pausarAgenteActionClassifier: {
      extractAction: vi.fn(async () => ({ accion: "pausar" as const, alcance: "global" as const })),
    },
    brokerAccionDirectaPlanner: { plan: vi.fn(async () => ({ actions: [], previewSummary: "" })) },
    confirmationClassifier: { extractConfirmation: vi.fn(async () => ({ confirmed: true })) },
    defaultLat: -34.6037,
    defaultLng: -58.3816,
    modoSilencioso: true,
    ...overrides,
  } as HandleMessageDeps;
}

function mensaje(text: string, from = "5491133339999"): IncomingWhatsAppMessage {
  return { from, messageId: `wamid.${text.length}`, text };
}

/** Intent que NO escala: es el caso que antes se respondía solo. */
const CONSULTA = { intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" };
/** Intent que ya escalaba de antes. */
const RECLAMO = { intentId: "reclamo_queja", confidence: 0.9 };

describe("modo silencioso", () => {
  describe("no le responde nada al cliente", () => {
    it("una consulta que antes se respondía sola ahora devuelve null", async () => {
      const resultado = await handleIncomingMessage(mensaje("¿sigue disponible?"), deps(CONSULTA));

      // null es el contrato que app.ts entiende como "no hay nada que mandar".
      expect(resultado.responseText).toBeNull();
    });

    it("tampoco sale la plantilla de espera de un mensaje que escala", async () => {
      const resultado = await handleIncomingMessage(mensaje("esto es un desastre"), deps(RECLAMO));

      expect(resultado.responseText).toBeNull();
    });

    it("con el modo apagado sí responde, como siempre", async () => {
      const resultado = await handleIncomingMessage(
        mensaje("¿sigue disponible?"),
        deps(CONSULTA, { modoSilencioso: false })
      );

      expect(resultado.responseText).not.toBeNull();
    });
  });

  // Modo de fallo 2 del pre-mortem.
  describe("el broker se entera igual", () => {
    it("manda el borrador incluso cuando el intent NO escala", async () => {
      const notifier = notifierEspia();
      await handleIncomingMessage(mensaje("¿sigue disponible?"), deps(CONSULTA, { brokerNotifier: notifier }));

      expect(notifier.notificaciones).toHaveLength(1);
      expect(notifier.notificaciones[0]).toMatchObject({
        conversationId: "5491133339999",
        incomingMessage: "¿sigue disponible?",
        matchedIntentId: "consulta_disponibilidad",
        draftReply: "borrador sugerido",
      });
    });

    it("le avisa explícitamente que el cliente NO recibió nada", async () => {
      const notifier = notifierEspia();
      await handleIncomingMessage(mensaje("¿sigue disponible?"), deps(CONSULTA, { brokerNotifier: notifier }));

      expect(notifier.notificaciones[0]?.escalationReason).toContain("NO recibió respuesta");
    });

    it("con el modo apagado, un intent que no escala no lo molesta", async () => {
      const notifier = notifierEspia();
      await handleIncomingMessage(
        mensaje("¿sigue disponible?"),
        deps(CONSULTA, { brokerNotifier: notifier, modoSilencioso: false })
      );

      expect(notifier.notificaciones).toHaveLength(0);
    });
  });

  // El audit log es lo que se usa para reconstruir un incidente. Si dijera que
  // se envió algo que no se envió, el próximo informe saldría mal.
  describe("el audit log dice la verdad", () => {
    it("no registra ninguna respuesta enviada", async () => {
      const auditLog = new InMemoryAuditLogStore();
      await handleIncomingMessage(mensaje("¿sigue disponible?"), deps(CONSULTA, { auditLog }));

      const entradas = await auditLog.readAll();
      expect(entradas).toHaveLength(1);
      expect(entradas[0]?.responseSent).toBeUndefined();
    });

    it("sigue registrando qué intent matcheó y con qué confianza", async () => {
      const auditLog = new InMemoryAuditLogStore();
      await handleIncomingMessage(mensaje("¿sigue disponible?"), deps(CONSULTA, { auditLog }));

      const entradas = await auditLog.readAll();
      expect(entradas[0]).toMatchObject({
        matchedIntentId: "consulta_disponibilidad",
        confidence: 0.95,
      });
      expect(entradas[0]?.toolsCalled.length).toBeGreaterThan(0);
    });
  });
});
