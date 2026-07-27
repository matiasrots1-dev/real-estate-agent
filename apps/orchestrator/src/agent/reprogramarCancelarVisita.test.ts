import { describe, expect, it, vi } from "vitest";
import type { Appointment, ConversationState, Intent, Property } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore, idleState } from "./conversationStateStore.js";
import {
  startReprogramarCancelarVisita,
  continueReprogramarCancelarVisita,
  type ReprogramarCancelarVisitaDeps,
} from "./reprogramarCancelarVisita.js";

const intent: Intent = {
  id: "reprogramar_cancelar_visita",
  description: "Cliente quiere cambiar o cancelar una visita ya agendada.",
  channel: "cliente",
  priority: "high",
  triggers: { examples: ["cancelame la visita de mañana"] },
  tools: ["gcal.get_event", "gcal.patch_event", "gcal.delete_event", "tokko.log_activity"],
  requires_client_confirmation: true,
  requires_broker: "conditional",
  escalation_reason: "Si es la 2da reprogramación de la misma visita, escalar.",
  confidence_threshold: 0.75,
  response: { style: "template", template: "Listo, {accion} tu visita de {direccion_corta}. {detalle_nuevo_horario}" },
};

const property: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
};

function sampleAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    leadId: "5491100000001",
    propertyId: "prop-1",
    gcalEventId: "evt-1",
    fechaHora: "2026-08-05T12:00:00.000Z",
    estado: "confirmada",
    vecesReprogramada: 0,
    remindersSent: [],
    ...overrides,
  };
}

function message(text: string): IncomingWhatsAppMessage {
  return { from: "5491100000001", messageId: "wamid.abc", text };
}

function makeGcal(overrides: Partial<GcalQueries> = {}): GcalQueries {
  return {
    freebusy: vi.fn(async () => []),
    createEvent: vi.fn(),
    patchEvent: vi.fn(async () => ({ id: "evt-1", summary: "Visita", start: "x", end: "y", status: "confirmed" })),
    deleteEvent: vi.fn(async () => {}),
    getEvent: vi.fn(),
    listEvents: vi.fn(),
    ...overrides,
  };
}

function makeTokko(overrides: Partial<TokkoQueries> = {}): TokkoQueries {
  return {
    searchProperties: vi.fn(),
    getProperty: vi.fn(async () => property),
    logActivity: vi.fn(async () => ({ logged: true as const, activityId: "act-1" })),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReprogramarCancelarVisitaDeps> = {}): ReprogramarCancelarVisitaDeps {
  return {
    tokko: makeTokko(),
    gcal: makeGcal(),
    conversationStateStore: new InMemoryConversationStateStore(),
    appointmentStore: new InMemoryAppointmentStore(),
    slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: 0 })) },
    reprogramActionClassifier: { extractAction: vi.fn(async () => ({ accion: "reprogramar" as const })) },
    ...overrides,
  };
}

describe("startReprogramarCancelarVisita", () => {
  it("si no hay visita activa, pide aclaración sin tocar nada", async () => {
    const deps = makeDeps();
    const result = await startReprogramarCancelarVisita(message("cancelame la visita"), intent, deps);
    expect(result.escalate).toBe(false);
    expect(result.responseText).toMatch(/no te veo/i);
  });

  it("cancelar: borra el evento, loguea, marca la visita cancelada, y responde con el template", async () => {
    const appointmentStore = new InMemoryAppointmentStore();
    await appointmentStore.save(sampleAppointment());
    const deps = makeDeps({
      appointmentStore,
      reprogramActionClassifier: { extractAction: vi.fn(async () => ({ accion: "cancelar" as const })) },
    });

    const result = await startReprogramarCancelarVisita(message("cancelame la visita de mañana"), intent, deps);

    expect(deps.gcal.deleteEvent).toHaveBeenCalledWith("evt-1");
    expect(deps.tokko.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: "visita_cancelada" })
    );
    expect(result.responseText).toBe("Listo, cancelamos tu visita de Depto Palermo.");
    expect((await appointmentStore.findById("appt-1"))?.estado).toBe("cancelada");
  });

  it("reprogramar por 2da vez (vecesReprogramada >= 1): escala en vez de proponer horarios de nuevo", async () => {
    const appointmentStore = new InMemoryAppointmentStore();
    await appointmentStore.save(sampleAppointment({ vecesReprogramada: 1 }));
    const deps = makeDeps({ appointmentStore });

    const result = await startReprogramarCancelarVisita(message("¿lo pasamos de nuevo?"), intent, deps);

    expect(result.escalate).toBe(true);
    expect(deps.gcal.freebusy).not.toHaveBeenCalled();
  });

  it("reprogramar por 1ra vez: propone horarios y deja la conversación esperando confirmación", async () => {
    const appointmentStore = new InMemoryAppointmentStore();
    await appointmentStore.save(sampleAppointment());
    const conversationStateStore = new InMemoryConversationStateStore();
    const deps = makeDeps({ appointmentStore, conversationStateStore });

    const result = await startReprogramarCancelarVisita(message("¿lo pasamos para otro día?"), intent, deps);

    expect(result.escalate).toBe(false);
    const state = await conversationStateStore.get("5491100000001");
    expect(state?.step).toBe("esperando_confirmacion_reprogramacion");
    expect(state?.currentIntentId).toBe("reprogramar_cancelar_visita");
  });
});

describe("continueReprogramarCancelarVisita", () => {
  function stateWithProposal(): ConversationState {
    const state = idleState("5491100000001", "5491100000001");
    state.currentIntentId = "reprogramar_cancelar_visita";
    state.step = "esperando_confirmacion_reprogramacion";
    state.context = {
      appointmentId: "appt-1",
      propertyId: "prop-1",
      gcalEventId: "evt-1",
      proposedSlots: [{ startDateTime: "2026-08-06T12:00:00.000Z", endDateTime: "2026-08-06T12:30:00.000Z" }],
      proposedLabels: ["jueves 09:00"],
    };
    return state;
  }

  it("si el cliente elige un horario: patchea el evento, incrementa vecesReprogramada, y vuelve a idle", async () => {
    const appointmentStore = new InMemoryAppointmentStore();
    await appointmentStore.save(sampleAppointment());
    const deps = makeDeps({ appointmentStore });

    const result = await continueReprogramarCancelarVisita(message("el jueves está bien"), stateWithProposal(), intent, deps);

    expect(deps.gcal.patchEvent).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ startDateTime: "2026-08-06T12:00:00.000Z" })
    );
    expect(result.responseText).toContain("reprogramamos");

    const updated = await appointmentStore.findById("appt-1");
    expect(updated?.vecesReprogramada).toBe(1);
    expect(updated?.fechaHora).toBe("2026-08-06T12:00:00.000Z");

    const finalState = await deps.conversationStateStore.get("5491100000001");
    expect(finalState?.step).toBe("idle");
  });

  it("si no elige ninguno: escala y vuelve a idle sin tocar el calendario", async () => {
    const deps = makeDeps({
      slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: null })) },
    });

    const result = await continueReprogramarCancelarVisita(message("ninguno me sirve"), stateWithProposal(), intent, deps);

    expect(result.escalate).toBe(true);
    expect(deps.gcal.patchEvent).not.toHaveBeenCalled();
  });
});
