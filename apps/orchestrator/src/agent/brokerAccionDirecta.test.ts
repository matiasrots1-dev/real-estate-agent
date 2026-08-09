import { describe, expect, it, vi } from "vitest";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore, idleState } from "./conversationStateStore.js";
import type { ActionPlan, BrokerAccionDirectaPlanner, PlannedAction } from "./brokerAccionDirectaPlan.js";
import type { ConfirmationClassifier } from "./confirmationClassifier.js";
import { runBrokerAccionDirecta, continueBrokerAccionDirecta, type BrokerAccionDirectaDeps } from "./brokerAccionDirecta.js";

const BROKER_NUMBER = "5491199999999";

function incoming(text: string): IncomingWhatsAppMessage {
  return { from: BROKER_NUMBER, messageId: "wamid.abc", text };
}

function stubPlanner(plan: ActionPlan): BrokerAccionDirectaPlanner {
  return { plan: vi.fn(async () => plan) };
}

function stubConfirmation(confirmed: boolean): ConfirmationClassifier {
  return { extractConfirmation: vi.fn(async () => ({ confirmed })) };
}

function stubGcal(): GcalQueries {
  return {
    freebusy: vi.fn(),
    createEvent: vi.fn(async () => ({ id: "evt-nuevo", summary: "Visita", start: "x", end: "y", status: "confirmed" })),
    patchEvent: vi.fn(async () => ({ id: "evt-1", summary: "Visita", start: "x", end: "y", status: "confirmed" })),
    deleteEvent: vi.fn(),
    getEvent: vi.fn(),
    listEvents: vi.fn(),
  };
}

/**
 * Desde el Bloque 16 el plan identifica a cada lead solo por `id`: el
 * teléfono lo resuelve el executor contra Tokko al ejecutar.
 */
function tokkoConLead(): TokkoQueries {
  return {
    searchProperties: vi.fn(),
    getProperty: vi.fn(),
    searchLeads: vi.fn(async () => []),
    getLead: vi.fn(async (id: string) => ({
      id,
      tokkoId: "tokko-" + id,
      nombre: "Lead de Prueba",
      telefonoWhatsapp: "5491100000001",
      temperatura: "frio" as const,
      propiedadesDeInteres: [],
      diasSinRespuesta: 45,
    })),
    logActivity: vi.fn(),
  };
}

function stubSender(): WhatsAppSender & { sent: Array<{ to: string; body: string }> } {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    sent,
    sendText: vi.fn(async (to: string, body: string) => {
      sent.push({ to, body });
      return { raw: { messaging_product: "whatsapp" } };
    }),
    sendImage: vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } })),
    sendTemplate: vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } })),
  };
}

function baseDeps(overrides: Partial<BrokerAccionDirectaDeps> = {}): BrokerAccionDirectaDeps {
  return {
    planner: stubPlanner({ actions: [], previewSummary: "no-op" }),
    confirmationClassifier: stubConfirmation(true),
    gcal: stubGcal(),
    appointmentStore: new InMemoryAppointmentStore(),
    tokko: tokkoConLead(),
    conversationStateStore: new InMemoryConversationStateStore(),
    sender: stubSender(),
    ...overrides,
  };
}

const singleContactAction: PlannedAction = {
  type: "whatsapp_send_message",
  leadId: "lead-1",

  message: "Hola! Te paso la ficha.",
};

function bulkActions(n: number): PlannedAction[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "whatsapp_send_message" as const,
    leadId: `lead-${i}`,

    message: "Bajamos el precio del depto de Nuñez.",
  }));
}

describe("runBrokerAccionDirecta — el gate bulk nunca ejecuta sin confirmación (prioridad de docs/TASKS.md Bloque 10)", () => {
  it("plan con más de un contacto: NO ejecuta ninguna acción todavía", async () => {
    const sender = stubSender();
    const gcal = stubGcal();
    const deps = baseDeps({ planner: stubPlanner({ actions: bulkActions(14), previewSummary: "Bajamos el precio." }), sender, gcal });

    await runBrokerAccionDirecta(incoming("avisale a todos los leads fríos"), deps);

    expect(sender.sendText).not.toHaveBeenCalled();
    expect(gcal.createEvent).not.toHaveBeenCalled();
    expect(gcal.patchEvent).not.toHaveBeenCalled();
  });

  it("plan bulk: la respuesta es un preview con el conteo exacto de contactos y pide confirmación", async () => {
    const deps = baseDeps({ planner: stubPlanner({ actions: bulkActions(14), previewSummary: "Bajamos el precio del depto de Nuñez." }) });

    const result = await runBrokerAccionDirecta(incoming("avisale a todos los leads fríos"), deps);

    expect(result.responseText).toContain("14 contactos");
    expect(result.responseText).toMatch(/confirmás/i);
    expect(result.toolsCalled).toEqual([]);
  });

  it("plan bulk: cuenta CONTACTOS distintos, no acciones — 2 acciones sobre el mismo lead no cuentan como bulk", async () => {
    const gcal = stubGcal();
    const actions: PlannedAction[] = [
      { type: "whatsapp_send_message", leadId: "lead-1", message: "Te paso la ficha." },
      {
        type: "gcal_create_event",
        leadId: "lead-1",
        propertyId: "prop-1",
        startDateTime: "2026-08-02T14:00:00.000Z",
        endDateTime: "2026-08-02T14:30:00.000Z",
        summary: "Visita",
      },
    ];
    const deps = baseDeps({ planner: stubPlanner({ actions, previewSummary: "x" }), gcal });

    const result = await runBrokerAccionDirecta(incoming("mandale la ficha a Juan y ofrecele el sábado"), deps);

    // Un solo contacto -> se ejecuta directo, no queda pendiente de confirmación.
    expect(gcal.createEvent).toHaveBeenCalledTimes(1);
    expect(result.responseText).not.toMatch(/confirmás/i);
  });

  it("plan bulk: deja el ConversationState del broker en esperando_ok_broker con el plan guardado", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    const actions = bulkActions(3);
    const deps = baseDeps({ planner: stubPlanner({ actions, previewSummary: "x" }), conversationStateStore });

    await runBrokerAccionDirecta(incoming("avisale a todos"), deps);

    const state = await conversationStateStore.get(BROKER_NUMBER);
    expect(state?.step).toBe("esperando_ok_broker");
    expect(state?.currentIntentId).toBe("broker_accion_directa");
    expect((state?.context as { actions: PlannedAction[] }).actions).toEqual(actions);
  });
});

describe("runBrokerAccionDirecta — un solo contacto se ejecuta directo (requires_client_confirmation: false)", () => {
  it("ejecuta la acción y resume lo que se hizo", async () => {
    const sender = stubSender();
    const deps = baseDeps({ planner: stubPlanner({ actions: [singleContactAction], previewSummary: "x" }), sender });

    const result = await runBrokerAccionDirecta(incoming("mandale un mensaje a Juan"), deps);

    expect(sender.sent).toEqual([{ to: "5491100000001", body: "Hola! Te paso la ficha." }]);
    expect(result.toolsCalled).toEqual(["whatsapp.send_message"]);
  });

  it("plan vacío (Claude no encontró qué hacer): no ejecuta nada y devuelve el previewSummary tal cual", async () => {
    const deps = baseDeps({ planner: stubPlanner({ actions: [], previewSummary: "No encontré ningún lead llamado Roberto." }) });

    const result = await runBrokerAccionDirecta(incoming("avisale a Roberto"), deps);

    expect(result.responseText).toBe("No encontré ningún lead llamado Roberto.");
    expect(result.toolsCalled).toEqual([]);
  });
});

describe("continueBrokerAccionDirecta — turno 2 (confirmación del broker)", () => {
  function pendingState(actions: PlannedAction[]) {
    return {
      ...idleState(BROKER_NUMBER, BROKER_NUMBER),
      channel: "broker" as const,
      currentIntentId: "broker_accion_directa",
      step: "esperando_ok_broker" as const,
      context: { actions } as unknown as Record<string, unknown>,
    };
  }

  it("confirmación ambigua/negativa: NO ejecuta el plan guardado", async () => {
    const sender = stubSender();
    const deps = baseDeps({ confirmationClassifier: stubConfirmation(false), sender });

    await continueBrokerAccionDirecta(incoming("mmm no sé, dejalo por ahora"), pendingState(bulkActions(5)), deps);

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it("confirmación negativa: resetea a idle sin ejecutar nada y avisa que no hizo nada", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    const deps = baseDeps({ confirmationClassifier: stubConfirmation(false), conversationStateStore });

    const result = await continueBrokerAccionDirecta(incoming("no, cancelalo"), pendingState(bulkActions(3)), deps);

    expect(result.responseText).toMatch(/no hago nada/i);
    expect((await conversationStateStore.get(BROKER_NUMBER))?.step).toBe("idle");
  });

  it("confirmación positiva clara: ejecuta cada acción del plan guardado", async () => {
    const sender = stubSender();
    const actions = bulkActions(3);
    const deps = baseDeps({ confirmationClassifier: stubConfirmation(true), sender });

    const result = await continueBrokerAccionDirecta(incoming("sí, dale, confirmado"), pendingState(actions), deps);

    expect(sender.sent).toHaveLength(3);
    expect(result.toolsCalled).toEqual(["whatsapp.send_message", "whatsapp.send_message", "whatsapp.send_message"]);
  });

  it("confirmación positiva: resetea la conversación del broker a idle después de ejecutar", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    const deps = baseDeps({ confirmationClassifier: stubConfirmation(true), conversationStateStore });

    await continueBrokerAccionDirecta(incoming("dale"), pendingState(bulkActions(2)), deps);

    expect(await conversationStateStore.get(BROKER_NUMBER)).toMatchObject({ step: "idle" });
  });

  it("el classifier no puede leer la respuesta (ej. Claude truncado): NO ejecuta, NO descarta el plan, y avisa del error en vez de asumir un no", async () => {
    // Caso real encontrado en vivo (docs/TASKS.md Bloque 10, 2026-07-28):
    // antes esto cascaba en silencio a confirmed: false. Que la rama fuera
    // segura era casualidad, no diseño — acá se verifica el diseño real.
    const sender = stubSender();
    const conversationStateStore = new InMemoryConversationStateStore();
    const actions = bulkActions(3);
    const state = pendingState(actions);
    await conversationStateStore.save(state);
    const failingClassifier: ConfirmationClassifier = {
      extractConfirmation: vi.fn(async () => {
        throw new Error("ClaudeConfirmationClassifier: respuesta incompleta o mal formada de Claude");
      }),
    };
    const deps = baseDeps({ confirmationClassifier: failingClassifier, sender, conversationStateStore });

    const result = await continueBrokerAccionDirecta(incoming("sí, dale, confirmado"), state, deps);

    expect(sender.sendText).not.toHaveBeenCalled();
    expect(result.toolsCalled).toEqual([]);
    expect(result.responseText).toMatch(/no pude interpretar/i);
    // El plan sigue pendiente tal cual estaba — no se resetea a idle.
    expect(await conversationStateStore.get(BROKER_NUMBER)).toEqual(state);
  });
});
