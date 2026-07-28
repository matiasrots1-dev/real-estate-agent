import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ConversationState, IntentCatalog } from "shared-types";
import type { AgendarVisitaDeps } from "./agendarVisita.js";
import type { ReprogramarCancelarVisitaDeps } from "./reprogramarCancelarVisita.js";
import type { BrokerAccionDirectaDeps } from "./brokerAccionDirecta.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore, idleState } from "./conversationStateStore.js";
import { loadCatalog } from "./intentCatalog.js";
import { continueConversationIfActive } from "./stateMachine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));

function message(text: string) {
  return { from: "5491100000001", messageId: "wamid.abc", text };
}

function agendarDeps(overrides: Partial<AgendarVisitaDeps> = {}): AgendarVisitaDeps {
  return {
    tokko: { searchProperties: vi.fn(), getProperty: vi.fn(async () => null), logActivity: vi.fn() },
    gcal: {
      freebusy: vi.fn(),
      createEvent: vi.fn(async () => ({ id: "evt-1", summary: "x", start: "a", end: "b", status: "confirmed" })),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
      getEvent: vi.fn(),
      listEvents: vi.fn(),
    },
    conversationStateStore: new InMemoryConversationStateStore(),
    appointmentStore: new InMemoryAppointmentStore(),
    composer: { compose: vi.fn(async () => "respuesta") },
    slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: 0 })) },
    language: "es-AR",
    ...overrides,
  };
}

function reprogramarDeps(overrides: Partial<ReprogramarCancelarVisitaDeps> = {}): ReprogramarCancelarVisitaDeps {
  return {
    tokko: { searchProperties: vi.fn(), getProperty: vi.fn(async () => null), logActivity: vi.fn() },
    gcal: {
      freebusy: vi.fn(),
      createEvent: vi.fn(),
      patchEvent: vi.fn(async () => ({ id: "evt-1", summary: "x", start: "a", end: "b", status: "confirmed" })),
      deleteEvent: vi.fn(),
      getEvent: vi.fn(),
      listEvents: vi.fn(),
    },
    conversationStateStore: new InMemoryConversationStateStore(),
    appointmentStore: new InMemoryAppointmentStore(),
    slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: 0 })) },
    reprogramActionClassifier: { extractAction: vi.fn(async () => ({ accion: "reprogramar" as const })) },
    ...overrides,
  };
}

function brokerAccionDirectaDeps(overrides: Partial<BrokerAccionDirectaDeps> = {}): BrokerAccionDirectaDeps {
  return {
    planner: { plan: vi.fn(async () => ({ actions: [], previewSummary: "x" })) },
    confirmationClassifier: { extractConfirmation: vi.fn(async () => ({ confirmed: true })) },
    gcal: {
      freebusy: vi.fn(),
      createEvent: vi.fn(),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
      getEvent: vi.fn(),
      listEvents: vi.fn(),
    },
    appointmentStore: new InMemoryAppointmentStore(),
    conversationStateStore: new InMemoryConversationStateStore(),
    ...overrides,
  };
}

function stateFor(currentIntentId: string, step: ConversationState["step"], context: unknown = {}): ConversationState {
  const state = idleState("5491100000001", "5491100000001");
  state.currentIntentId = currentIntentId;
  state.step = step;
  state.context = context as Record<string, unknown>;
  return state;
}

describe("continueConversationIfActive", () => {
  it("rutea a continueAgendarVisita cuando currentIntentId/step matchean agendar_visita", async () => {
    const slotConfirmationClassifier = { matchSlot: vi.fn(async () => ({ chosenIndex: null })) };
    const deps = agendarDeps({ slotConfirmationClassifier });
    const state = stateFor("agendar_visita", "esperando_confirmacion_horario", {
      propertyId: "prop-1",
      proposedSlots: [{ startDateTime: "2026-08-05T12:00:00.000Z", endDateTime: "2026-08-05T12:30:00.000Z" }],
      proposedLabels: ["miércoles 09:00"],
    });

    const result = await continueConversationIfActive(message("ninguno me sirve"), state, {
      catalog,
      agendarVisita: deps,
      reprogramarCancelarVisita: reprogramarDeps(),
      brokerAccionDirecta: brokerAccionDirectaDeps(),
    });

    expect(result?.matchedIntentId).toBe("agendar_visita");
    expect(slotConfirmationClassifier.matchSlot).toHaveBeenCalledWith("ninguno me sirve", ["miércoles 09:00"]);
    expect(result?.escalate).toBe(true);
  });

  it("rutea a continueReprogramarCancelarVisita cuando currentIntentId/step matchean reprogramar_cancelar_visita", async () => {
    const slotConfirmationClassifier = { matchSlot: vi.fn(async () => ({ chosenIndex: 0 })) };
    const appointmentStore = new InMemoryAppointmentStore();
    await appointmentStore.save({
      id: "appt-1",
      leadId: "5491100000001",
      propertyId: "prop-1",
      gcalEventId: "evt-1",
      fechaHora: "2026-08-05T12:00:00.000Z",
      estado: "confirmada",
      vecesReprogramada: 0,
      remindersSent: [],
    });
    const deps = reprogramarDeps({ slotConfirmationClassifier, appointmentStore });
    const state = stateFor("reprogramar_cancelar_visita", "esperando_confirmacion_reprogramacion", {
      appointmentId: "appt-1",
      propertyId: "prop-1",
      gcalEventId: "evt-1",
      proposedSlots: [{ startDateTime: "2026-08-06T12:00:00.000Z", endDateTime: "2026-08-06T12:30:00.000Z" }],
      proposedLabels: ["jueves 09:00"],
    });

    const result = await continueConversationIfActive(message("el jueves está bien"), state, {
      catalog,
      agendarVisita: agendarDeps(),
      reprogramarCancelarVisita: deps,
      brokerAccionDirecta: brokerAccionDirectaDeps(),
    });

    expect(result?.matchedIntentId).toBe("reprogramar_cancelar_visita");
    expect(result?.escalate).toBe(false);
  });

  it("devuelve null si el step no matchea el intent activo (estado inconsistente)", async () => {
    const state = stateFor("agendar_visita", "esperando_confirmacion_reprogramacion");
    const result = await continueConversationIfActive(message("hola"), state, {
      catalog,
      agendarVisita: agendarDeps(),
      reprogramarCancelarVisita: reprogramarDeps(),
      brokerAccionDirecta: brokerAccionDirectaDeps(),
    });
    expect(result).toBeNull();
  });

  it("devuelve null si currentIntentId no es ninguno de los flujos multi-turno conocidos", async () => {
    const state = stateFor("consulta_disponibilidad", "esperando_confirmacion_horario");
    const result = await continueConversationIfActive(message("hola"), state, {
      catalog,
      agendarVisita: agendarDeps(),
      reprogramarCancelarVisita: reprogramarDeps(),
      brokerAccionDirecta: brokerAccionDirectaDeps(),
    });
    expect(result).toBeNull();
  });

  it("rutea a continueBrokerAccionDirecta cuando currentIntentId/step matchean broker_accion_directa (Bloque 10)", async () => {
    const confirmationClassifier = { extractConfirmation: vi.fn(async () => ({ confirmed: true })) };
    const sentText = vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } }));
    const deps = brokerAccionDirectaDeps({
      confirmationClassifier,
      sender: { sendText: sentText, sendImage: vi.fn(), sendTemplate: vi.fn() },
    });
    const state = stateFor("broker_accion_directa", "esperando_ok_broker", {
      actions: [{ type: "whatsapp_send_message", leadId: "lead-1", phone: "5491100000001", message: "Bajamos el precio." }],
    });

    const result = await continueConversationIfActive({ from: "5491199999999", messageId: "wamid.x", text: "sí, dale" }, state, {
      catalog,
      agendarVisita: agendarDeps(),
      reprogramarCancelarVisita: reprogramarDeps(),
      brokerAccionDirecta: deps,
    });

    expect(result?.matchedIntentId).toBe("broker_accion_directa");
    expect(result?.escalate).toBe(false);
    expect(sentText).toHaveBeenCalledWith("5491100000001", "Bajamos el precio.");
  });
});
