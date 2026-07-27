import { describe, expect, it, vi } from "vitest";
import type { ConversationState, Intent, Property } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { GcalQueries, CalendarEvent } from "../mcp/gcalMcpClient.js";
import type { ResponseComposer } from "./composer.js";
import type { SlotConfirmationClassifier } from "./slotConfirmation.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore, idleState } from "./conversationStateStore.js";
import { startAgendarVisita, continueAgendarVisita, type AgendarVisitaDeps } from "./agendarVisita.js";

const intent: Intent = {
  id: "agendar_visita",
  description: "Cliente quiere coordinar una visita presencial.",
  channel: "cliente",
  priority: "high",
  triggers: { examples: ["quiero ir a verlo"] },
  tools: ["gcal.freebusy", "gcal.create_event", "tokko.log_activity"],
  requires_client_confirmation: true,
  requires_broker: "conditional",
  escalation_reason:
    "Solo si no hay disponibilidad compatible en las próximas 72hs o el cliente pide un horario fuera de rango habitual.",
  confidence_threshold: 0.75,
  response: { style: "generative_grounded", grounding_fields: ["horarios_disponibles"] },
};

const property: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
};

const createdEvent: CalendarEvent = {
  id: "evt-new",
  summary: "Visita - Depto Palermo",
  start: "2026-08-05T12:00:00.000Z",
  end: "2026-08-05T12:30:00.000Z",
  status: "confirmed",
};

function message(text: string): IncomingWhatsAppMessage {
  return { from: "5491100000001", messageId: "wamid.abc", text };
}

function makeGcal(overrides: Partial<GcalQueries> = {}): GcalQueries {
  return {
    freebusy: vi.fn(async () => []),
    createEvent: vi.fn(async () => createdEvent),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
    getEvent: vi.fn(),
    listEvents: vi.fn(),
    ...overrides,
  };
}

function makeTokko(overrides: Partial<TokkoQueries> = {}): TokkoQueries {
  return {
    searchProperties: vi.fn(async () => [property]),
    getProperty: vi.fn(async () => property),
    logActivity: vi.fn(async () => ({ logged: true as const, activityId: "act-1" })),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AgendarVisitaDeps> = {}): AgendarVisitaDeps {
  return {
    tokko: makeTokko(),
    gcal: makeGcal(),
    conversationStateStore: new InMemoryConversationStateStore(),
    appointmentStore: new InMemoryAppointmentStore(),
    composer: { compose: vi.fn(async ({ groundingData }) => `Propongo: ${JSON.stringify(groundingData)}`) },
    slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: 0 })) },
    language: "es-AR",
    ...overrides,
  };
}

describe("startAgendarVisita", () => {
  it("pide aclaración si no encuentra la propiedad", async () => {
    const deps = makeDeps({ tokko: makeTokko({ searchProperties: vi.fn(async () => []) }) });
    const result = await startAgendarVisita(message("quiero ir a verlo"), { intentId: "agendar_visita", confidence: 0.9 }, intent, deps);

    expect(result.escalate).toBe(false);
    expect(result.responseText).toMatch(/propiedad/);
  });

  it("propone horarios y deja la conversación esperando confirmación", async () => {
    const deps = makeDeps();
    const result = await startAgendarVisita(
      message("quiero ir a verlo"),
      { intentId: "agendar_visita", confidence: 0.9, searchQuery: "Palermo" },
      intent,
      deps
    );

    expect(result.escalate).toBe(false);
    expect(deps.composer.compose).toHaveBeenCalled();

    const savedState = await deps.conversationStateStore.get("5491100000001");
    expect(savedState?.step).toBe("esperando_confirmacion_horario");
    expect(savedState?.currentIntentId).toBe("agendar_visita");
    expect((savedState?.context as any).propertyId).toBe("prop-1");
  });

  it("escala si no hay ningún horario libre en las próximas 72hs", async () => {
    const deps = makeDeps({
      gcal: makeGcal({
        freebusy: vi.fn(async () => [{ start: "2020-01-01T00:00:00Z", end: "2030-01-01T00:00:00Z" }]),
      }),
    });
    const result = await startAgendarVisita(
      message("quiero ir a verlo"),
      { intentId: "agendar_visita", confidence: 0.9, searchQuery: "Palermo" },
      intent,
      deps
    );

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe(intent.escalation_reason);
    // no debería quedar esperando confirmación de algo que nunca se propuso
    expect(await deps.conversationStateStore.get("5491100000001")).toBeNull();
  });
});

describe("continueAgendarVisita", () => {
  function stateWithProposal(): ConversationState {
    const state = idleState("5491100000001", "5491100000001");
    state.currentIntentId = "agendar_visita";
    state.step = "esperando_confirmacion_horario";
    state.context = {
      propertyId: "prop-1",
      proposedSlots: [
        { startDateTime: "2026-08-05T12:00:00.000Z", endDateTime: "2026-08-05T12:30:00.000Z" },
        { startDateTime: "2026-08-05T13:00:00.000Z", endDateTime: "2026-08-05T13:30:00.000Z" },
      ],
      proposedLabels: ["miércoles 09:00", "miércoles 10:00"],
    };
    return state;
  }

  it("si el cliente elige un horario: crea el evento, loguea actividad, guarda la visita, y vuelve a idle", async () => {
    const deps = makeDeps();
    const result = await continueAgendarVisita(message("el primero está bien"), stateWithProposal(), intent, deps);

    expect(result.escalate).toBe(false);
    expect(deps.gcal.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ startDateTime: "2026-08-05T12:00:00.000Z" })
    );
    expect(deps.tokko.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "5491100000001", propertyId: "prop-1", tipo: "visita_agendada" })
    );

    const appointment = await deps.appointmentStore.findActiveByLead("5491100000001");
    expect(appointment).toMatchObject({ propertyId: "prop-1", gcalEventId: "evt-new", estado: "confirmada" });

    const finalState = await deps.conversationStateStore.get("5491100000001");
    expect(finalState?.step).toBe("idle");
  });

  it("si el cliente no elige ninguno de los propuestos: escala y vuelve a idle sin crear nada", async () => {
    const deps = makeDeps({
      slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: null })) },
    });

    const result = await continueAgendarVisita(message("ninguno me sirve"), stateWithProposal(), intent, deps);

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe(intent.escalation_reason);
    expect(deps.gcal.createEvent).not.toHaveBeenCalled();
    expect(await deps.conversationStateStore.get("5491100000001")).toMatchObject({ step: "idle" });
  });
});
