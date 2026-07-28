import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IntentCatalog, Property } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { WeatherQueries } from "../mcp/weatherMcpClient.js";
import type { IntentClassification, IntentClassifier } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { DraftReplyComposer } from "./draftComposer.js";
import type { BrokerNotifier, BrokerNotification } from "./brokerNotifier.js";
import { InMemoryAuditLogStore } from "./auditLog.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore, idleState } from "./conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./globalPauseStore.js";
import type { PausarAgenteAction, PausarAgenteActionClassifier } from "./pausarAgenteClassifier.js";
import type { ActionPlan, BrokerAccionDirectaPlanner } from "./brokerAccionDirectaPlan.js";
import type { ConfirmationClassifier } from "./confirmationClassifier.js";
import { loadCatalog } from "./intentCatalog.js";
import { handleIncomingMessage, NotImplementedIntentError, type HandleMessageDeps } from "./handleIncomingMessage.js";

// Usa el catálogo REAL de docs/intent_catalog.yaml, no uno inventado — así
// estos tests también detectan si alguien cambia el YAML de forma
// incompatible con lo que el orchestrator asume (templates, requires_broker, etc).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));

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

function incoming(text: string, from = "5491100000001"): IncomingWhatsAppMessage {
  return { from, messageId: "wamid.abc", text };
}

function stubClassifier(result: IntentClassification): IntentClassifier {
  return { classify: vi.fn(async () => result) };
}

function stubComposer(text = "respuesta compuesta"): ResponseComposer {
  return { compose: vi.fn(async () => text) };
}

function stubDraftComposer(text = "borrador sugerido"): DraftReplyComposer {
  return { composeDraft: vi.fn(async () => text) };
}

function stubTokko(): TokkoQueries {
  return {
    searchProperties: vi.fn(async () => [property]),
    getProperty: vi.fn(async () => property),
    searchLeads: vi.fn(async () => []),
    getLead: vi.fn(async () => null),
    logActivity: vi.fn(async () => ({ logged: true as const, activityId: "act-1" })),
  };
}

function stubGcal(): GcalQueries {
  return {
    freebusy: vi.fn(async () => []),
    createEvent: vi.fn(async () => ({ id: "evt-1", summary: "Visita", start: "x", end: "y", status: "confirmed" })),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
    getEvent: vi.fn(),
    listEvents: vi.fn(),
  };
}

function stubWeather(): WeatherQueries {
  return { getForecast: vi.fn() };
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

function stubPausarAgenteActionClassifier(action: PausarAgenteAction): PausarAgenteActionClassifier {
  return { extractAction: vi.fn(async () => action) };
}

function stubBrokerAccionDirectaPlanner(plan: ActionPlan): BrokerAccionDirectaPlanner {
  return { plan: vi.fn(async () => plan) };
}

function stubConfirmationClassifier(confirmed: boolean): ConfirmationClassifier {
  return { extractConfirmation: vi.fn(async () => ({ confirmed })) };
}

/** Deps completas con stubs razonables — cada test sobreescribe solo lo que le importa. */
function baseDeps(overrides: Partial<HandleMessageDeps> = {}): HandleMessageDeps {
  return {
    catalog,
    classifier: stubClassifier({ intentId: "fallback_low_confidence", confidence: 0.1 }),
    composer: stubComposer(),
    draftComposer: stubDraftComposer(),
    tokko: stubTokko(),
    gcal: stubGcal(),
    weather: stubWeather(),
    auditLog: new InMemoryAuditLogStore(),
    appointmentStore: new InMemoryAppointmentStore(),
    conversationStateStore: new InMemoryConversationStateStore(),
    slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: 0 })) },
    reprogramActionClassifier: { extractAction: vi.fn(async () => ({ accion: "reprogramar" as const })) },
    globalPauseStore: new InMemoryGlobalPauseStore(),
    pausarAgenteActionClassifier: stubPausarAgenteActionClassifier({ accion: "pausar", alcance: "global" }),
    brokerAccionDirectaPlanner: stubBrokerAccionDirectaPlanner({ actions: [], previewSummary: "no-op" }),
    confirmationClassifier: stubConfirmationClassifier(true),
    defaultLat: -34.6037,
    defaultLng: -58.3816,
    ...overrides,
  };
}

const ESCALATING_INTENT_IDS = [
  "negociacion_precio",
  "reclamo_queja",
  "consulta_legal_contractual",
  "hablar_con_persona",
  "fallback_low_confidence",
] as const;

describe("handleIncomingMessage — intents que siempre escalan (Bloque 4)", () => {
  it.each(ESCALATING_INTENT_IDS)(
    '"%s": responde con el template del catálogo, no llama tools, y notifica al broker con el borrador',
    async (intentId) => {
      const auditLog = new InMemoryAuditLogStore();
      const draftComposer = stubDraftComposer("Hola! Dejame confirmarte eso.");
      const brokerNotifier = recordingBrokerNotifier();
      const intent = catalog.intents.find((i) => i.id === intentId);
      if (!intent) throw new Error(`Intent "${intentId}" no está en el catálogo real — revisar el test.`);

      const result = await handleIncomingMessage(
        incoming("mensaje de prueba"),
        baseDeps({
          classifier: stubClassifier({ intentId, confidence: 0.9 }),
          draftComposer,
          auditLog,
          brokerNotifier,
        })
      );

      expect(intent.requires_broker).toBe(true);
      expect(result.escalatedToBroker).toBe(true);
      expect(result.responseText).toBe(intent.response.template);

      expect(brokerNotifier.notify).toHaveBeenCalledTimes(1);
      expect(brokerNotifier.notifications[0]).toMatchObject({
        matchedIntentId: intentId,
        confidence: 0.9,
        draftReply: "Hola! Dejame confirmarte eso.",
      });

      const [entry] = await auditLog.readAll();
      expect(entry.escalationRule).toBe("requires_broker");
      expect(entry.escalationReason).toBe(intent.escalation_reason);
    }
  );

  it("confianza por debajo del umbral escala con rule=low_confidence aunque requires_broker sea false", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const result = await handleIncomingMessage(
      incoming("che disponible?"),
      baseDeps({ classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.5 }), auditLog })
    );

    expect(result.escalatedToBroker).toBe(true);
    expect(result.responseText).toMatch(/asesor/);
    const [entry] = await auditLog.readAll();
    expect(entry.escalationRule).toBe("low_confidence");
  });

  it("sin brokerNotifier configurado: igual escala y responde al cliente, solo que no notifica a nadie", async () => {
    const result = await handleIncomingMessage(
      incoming("quiero hablar con una persona"),
      baseDeps({ classifier: stubClassifier({ intentId: "hablar_con_persona", confidence: 0.95 }) })
    );
    expect(result.escalatedToBroker).toBe(true);
  });

  it("si notificar al broker falla, el cliente igual recibe su respuesta (best-effort, no rompe el loop)", async () => {
    const brokerNotifier: BrokerNotifier = {
      notify: vi.fn(async () => {
        throw new Error("WhatsApp Cloud API caída");
      }),
    };
    const result = await handleIncomingMessage(
      incoming("esto es un desastre"),
      baseDeps({ classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }), brokerNotifier })
    );
    const reclamoQueja = catalog.intents.find((i) => i.id === "reclamo_queja");
    expect(result.responseText).toBe(reclamoQueja?.response.template);
    expect(result.escalatedToBroker).toBe(true);
  });
});

describe("handleIncomingMessage — intents reactivos de un solo turno", () => {
  it("consulta_disponibilidad: ejecuta el handler, no escala, no notifica al broker", async () => {
    const brokerNotifier = recordingBrokerNotifier();
    const result = await handleIncomingMessage(
      incoming("¿el depto de Palermo sigue disponible?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        composer: stubComposer("Sigue disponible por $350.000."),
        brokerNotifier,
      })
    );

    expect(result).toEqual({
      responseText: "Sigue disponible por $350.000.",
      intentId: "consulta_disponibilidad",
      confidence: 0.95,
      escalatedToBroker: false,
      mediaUrls: undefined,
    });
    expect(brokerNotifier.notify).not.toHaveBeenCalled();
  });

  it("consulta_precio_condiciones: ya está implementado (Bloque 5), no tira NotImplementedIntentError", async () => {
    const result = await handleIncomingMessage(
      incoming("¿cuánto sale el alquiler?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_precio_condiciones", confidence: 0.9, searchQuery: "Palermo" }),
        composer: stubComposer("Sale $350.000."),
      })
    );
    expect(result.responseText).toBe("Sale $350.000.");
    expect(result.escalatedToBroker).toBe(false);
  });

  it("pedido_ficha_multimedia: expone mediaUrls en el resultado para que app.ts las mande como imágenes", async () => {
    const result = await handleIncomingMessage(
      incoming("mandame fotos"),
      baseDeps({ classifier: stubClassifier({ intentId: "pedido_ficha_multimedia", confidence: 0.9, searchQuery: "Palermo" }) })
    );
    expect(result.mediaUrls).toEqual(property.fotos);
  });

  it("consulta_clima_visita: sin visita agendada, pide confirmación sin tocar gcal/weather", async () => {
    const gcal = stubGcal();
    const weather = stubWeather();
    const result = await handleIncomingMessage(
      incoming("¿va a llover el sábado?"),
      baseDeps({ classifier: stubClassifier({ intentId: "consulta_clima_visita", confidence: 0.8 }), gcal, weather })
    );
    expect(result.responseText).toMatch(/visita agendada/);
    expect(gcal.getEvent).not.toHaveBeenCalled();
    expect(weather.getForecast).not.toHaveBeenCalled();
  });
});

describe("handleIncomingMessage — flujo multi-turno de agendar_visita (Bloque 5)", () => {
  it("primer mensaje propone horarios; el segundo (mismo conversationId) confirma y agenda", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    const appointmentStore = new InMemoryAppointmentStore();
    const gcal = stubGcal();

    const deps = baseDeps({
      conversationStateStore,
      appointmentStore,
      gcal,
      classifier: stubClassifier({ intentId: "agendar_visita", confidence: 0.9, searchQuery: "Palermo" }),
      composer: stubComposer("Tengo estos horarios: ..."),
      slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: 0 })) },
    });

    const first = await handleIncomingMessage(incoming("quiero ir a verlo"), deps);
    expect(first.escalatedToBroker).toBe(false);
    expect(await conversationStateStore.get("5491100000001")).toMatchObject({
      step: "esperando_confirmacion_horario",
      currentIntentId: "agendar_visita",
    });

    // Segundo mensaje: el classifier NO se vuelve a llamar para decidir el
    // intent — la máquina de estados rutea directo a la continuación.
    const second = await handleIncomingMessage(incoming("el primero está perfecto"), deps);

    expect(second.escalatedToBroker).toBe(false);
    expect(second.intentId).toBe("agendar_visita");
    expect(second.confidence).toBeNull();
    expect(gcal.createEvent).toHaveBeenCalledTimes(1);
    expect(await conversationStateStore.get("5491100000001")).toMatchObject({ step: "idle" });
    expect(await appointmentStore.findActiveByLead("5491100000001")).not.toBeNull();
  });
});

describe("handleIncomingMessage — intents sin handler todavía", () => {
  it("intent inexistente en el catálogo (alucinación del classifier): tira NotImplementedIntentError", async () => {
    await expect(
      handleIncomingMessage(
        incoming("mensaje raro"),
        baseDeps({ classifier: stubClassifier({ intentId: "intent_que_no_existe", confidence: 0.9 }) })
      )
    ).rejects.toThrow(NotImplementedIntentError);
  });
});

const BROKER_NUMBER = "5491199999999";

/** Classifier espía que registra qué catálogo (ya filtrado por canal) recibió, sin importarle el texto. */
function capturingClassifier(result: IntentClassification): IntentClassifier & { seenCatalog?: IntentCatalog } {
  const spy = {
    seenCatalog: undefined as IntentCatalog | undefined,
    classify: vi.fn(async (_text: string, catalog: IntentCatalog) => {
      spy.seenCatalog = catalog;
      return result;
    }),
  };
  return spy;
}

describe("handleIncomingMessage — canal broker (Bloque 8)", () => {
  it("mensaje de un cliente: el classifier recibe un catálogo sin intents channel=broker", async () => {
    const classifier = capturingClassifier({ intentId: "consulta_disponibilidad", confidence: 0.9, searchQuery: "Palermo" });

    await handleIncomingMessage(incoming("¿algo disponible?", "5491100000001"), baseDeps({ classifier, brokerWhatsappNumber: BROKER_NUMBER }));

    expect(classifier.seenCatalog).toBeDefined();
    expect(classifier.seenCatalog!.intents.some((i) => i.channel === "broker")).toBe(false);
    expect(classifier.seenCatalog!.intents.some((i) => i.id === "consulta_disponibilidad")).toBe(true);
  });

  it("mensaje del broker (message.from === brokerWhatsappNumber): el classifier recibe un catálogo sin intents channel=cliente", async () => {
    const classifier = capturingClassifier({ intentId: "broker_resumen_leads", confidence: 0.9 });

    await handleIncomingMessage(
      incoming("resumen de leads", BROKER_NUMBER),
      baseDeps({ classifier, brokerWhatsappNumber: BROKER_NUMBER, tokko: stubTokko() })
    );

    expect(classifier.seenCatalog).toBeDefined();
    expect(classifier.seenCatalog!.intents.some((i) => i.channel === "cliente")).toBe(false);
    expect(classifier.seenCatalog!.intents.some((i) => i.id === "broker_resumen_leads")).toBe(true);
  });

  it("sin brokerWhatsappNumber configurado: cualquier mensaje se trata como canal cliente", async () => {
    const classifier = capturingClassifier({ intentId: "consulta_disponibilidad", confidence: 0.9, searchQuery: "Palermo" });

    await handleIncomingMessage(incoming("¿algo disponible?", BROKER_NUMBER), baseDeps({ classifier }));

    expect(classifier.seenCatalog!.intents.some((i) => i.channel === "broker")).toBe(false);
  });

  it("broker_resumen_agenda: ejecuta el handler real (gcal.list_events + cruce con tokko.get_lead), no escala", async () => {
    const gcal = stubGcal();
    gcal.listEvents = vi.fn(async () => []);
    const result = await handleIncomingMessage(
      incoming("¿cómo viene la agenda?", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_resumen_agenda", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        gcal,
        composer: stubComposer("No tenés visitas esta semana."),
      })
    );

    expect(gcal.listEvents).toHaveBeenCalledTimes(1);
    expect(result.responseText).toBe("No tenés visitas esta semana.");
    expect(result.escalatedToBroker).toBe(false);
    expect(result.intentId).toBe("broker_resumen_agenda");
  });

  it("broker_resumen_leads: ejecuta el handler real (tokko.search_leads), no escala", async () => {
    const tokko = stubTokko();
    tokko.searchLeads = vi.fn(async () => []);
    const result = await handleIncomingMessage(
      incoming("¿cómo vienen los leads?", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_resumen_leads", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        tokko,
        composer: stubComposer("No tenés leads cargados."),
      })
    );

    expect(tokko.searchLeads).toHaveBeenCalledWith({});
    expect(result.responseText).toBe("No tenés leads cargados.");
    expect(result.escalatedToBroker).toBe(false);
    expect(result.intentId).toBe("broker_resumen_leads");
  });
});

describe("handleIncomingMessage — pausa del agente (Bloque 9)", () => {
  it("cliente con pausedByBroker=true: no clasifica, no responde, pero queda auditado", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    await conversationStateStore.save({ ...idleState("5491100000001", "5491100000001"), pausedByBroker: true });
    const classifier = stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.9 });
    const auditLog = new InMemoryAuditLogStore();

    const result = await handleIncomingMessage(
      incoming("¿algo disponible?"),
      baseDeps({ conversationStateStore, classifier, auditLog })
    );

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(result.responseText).toBeNull();
    expect(result.escalatedToBroker).toBe(false);

    const [entry] = await auditLog.readAll();
    expect(entry.incomingMessage).toBe("¿algo disponible?");
    expect(entry.responseSent).toBeUndefined();
    expect(entry.toolsCalled).toEqual([]);
  });

  it("pausa global activa: tampoco responde a ningún cliente, aunque su ConversationState no esté pausado puntualmente", async () => {
    const globalPauseStore = new InMemoryGlobalPauseStore();
    await globalPauseStore.setPaused(true);
    const classifier = stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.9 });

    const result = await handleIncomingMessage(incoming("¿algo disponible?"), baseDeps({ globalPauseStore, classifier }));

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(result.responseText).toBeNull();
  });

  it("pausa global activa: el broker igual puede hablar con el agente (nunca se lo pausa a él)", async () => {
    const globalPauseStore = new InMemoryGlobalPauseStore();
    await globalPauseStore.setPaused(true);
    const classifier = stubClassifier({ intentId: "broker_resumen_leads", confidence: 0.9 });

    const result = await handleIncomingMessage(
      incoming("¿cómo vienen los leads?", BROKER_NUMBER),
      baseDeps({ globalPauseStore, classifier, brokerWhatsappNumber: BROKER_NUMBER, tokko: stubTokko() })
    );

    expect(classifier.classify).toHaveBeenCalled();
    expect(result.intentId).toBe("broker_resumen_leads");
  });

  it("cliente sin pausa activa: sigue respondiendo normalmente", async () => {
    const result = await handleIncomingMessage(
      incoming("¿algo disponible?"),
      baseDeps({ classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.9, searchQuery: "Palermo" }) })
    );
    expect(result.responseText).not.toBeNull();
  });

  it("broker_pausar_agente (alcance global): ejecuta el handler real y prende el GlobalPauseStore", async () => {
    const globalPauseStore = new InMemoryGlobalPauseStore();
    const result = await handleIncomingMessage(
      incoming("pausá el agente por hoy", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_pausar_agente", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        globalPauseStore,
        pausarAgenteActionClassifier: stubPausarAgenteActionClassifier({ accion: "pausar", alcance: "global" }),
      })
    );

    expect(await globalPauseStore.isPaused()).toBe(true);
    expect(result.escalatedToBroker).toBe(false);
    expect(result.intentId).toBe("broker_pausar_agente");
  });

  it("broker_pausar_agente (alcance conversacion): marca pausedByBroker en el ConversationState del cliente indicado", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    await handleIncomingMessage(
      incoming("no le respondas más a 5491100000001", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_pausar_agente", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        conversationStateStore,
        pausarAgenteActionClassifier: stubPausarAgenteActionClassifier({
          accion: "pausar",
          alcance: "conversacion",
          telefonoCliente: "5491100000001",
        }),
      })
    );

    expect((await conversationStateStore.get("5491100000001"))?.pausedByBroker).toBe(true);
  });
});

describe("handleIncomingMessage — broker_accion_directa (Bloque 10)", () => {
  it("plan bulk (más de un contacto): NO ejecuta nada todavía, deja la conversación esperando confirmación", async () => {
    const gcal = stubGcal();
    const bulkActions = [
      { type: "whatsapp_send_message" as const, leadId: "lead-1", phone: "5491100000001", message: "Bajamos el precio." },
      { type: "whatsapp_send_message" as const, leadId: "lead-2", phone: "5491100000002", message: "Bajamos el precio." },
    ];

    const result = await handleIncomingMessage(
      incoming("avisale a todos los leads fríos que bajamos el precio", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_accion_directa", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        gcal,
        brokerAccionDirectaPlanner: stubBrokerAccionDirectaPlanner({ actions: bulkActions, previewSummary: "Bajamos el precio." }),
      })
    );

    expect(result.responseText).toContain("2 contactos");
    expect(result.responseText).toMatch(/confirmás/i);
    expect(gcal.createEvent).not.toHaveBeenCalled();
    expect(result.escalatedToBroker).toBe(false);
    expect(result.intentId).toBe("broker_accion_directa");
  });

  it("plan de un solo contacto: se ejecuta directo (requires_client_confirmation: false)", async () => {
    const sentText = vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } }));
    const result = await handleIncomingMessage(
      incoming("mandale un mensaje a Juan con la ficha", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_accion_directa", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        sender: { sendText: sentText, sendImage: vi.fn(), sendTemplate: vi.fn() },
        brokerAccionDirectaPlanner: stubBrokerAccionDirectaPlanner({
          actions: [{ type: "whatsapp_send_message", leadId: "lead-1", phone: "5491100000001", message: "Hola Juan!" }],
          previewSummary: "x",
        }),
      })
    );

    expect(sentText).toHaveBeenCalledWith("5491100000001", "Hola Juan!");
    expect(result.escalatedToBroker).toBe(false);
  });

  it("turno 2 con confirmación positiva: ejecuta el plan que había quedado pendiente", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    const sentText = vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } }));
    const deps = baseDeps({
      brokerWhatsappNumber: BROKER_NUMBER,
      conversationStateStore,
      sender: { sendText: sentText, sendImage: vi.fn(), sendTemplate: vi.fn() },
      confirmationClassifier: stubConfirmationClassifier(true),
    });

    // Turno 1: plan bulk, queda pendiente.
    await handleIncomingMessage(
      incoming("avisale a todos los leads fríos", BROKER_NUMBER),
      {
        ...deps,
        classifier: stubClassifier({ intentId: "broker_accion_directa", confidence: 0.9 }),
        brokerAccionDirectaPlanner: stubBrokerAccionDirectaPlanner({
          actions: [
            { type: "whatsapp_send_message", leadId: "lead-1", phone: "5491100000001", message: "Bajamos el precio." },
            { type: "whatsapp_send_message", leadId: "lead-2", phone: "5491100000002", message: "Bajamos el precio." },
          ],
          previewSummary: "Bajamos el precio.",
        }),
      }
    );
    expect(sentText).not.toHaveBeenCalled();

    // Turno 2: el broker confirma — ahora sí se ejecuta.
    const second = await handleIncomingMessage(incoming("sí, dale", BROKER_NUMBER), {
      ...deps,
      classifier: stubClassifier({ intentId: "broker_accion_directa", confidence: 0.9 }),
    });

    expect(sentText).toHaveBeenCalledTimes(2);
    expect(second.intentId).toBe("broker_accion_directa");
    expect((await conversationStateStore.get(BROKER_NUMBER))?.step).toBe("idle");
  });

  it("turno 2 sin confirmación clara: NO ejecuta el plan pendiente", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    const sentText = vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } }));
    const sender = { sendText: sentText, sendImage: vi.fn(), sendTemplate: vi.fn() };

    await handleIncomingMessage(
      incoming("avisale a todos los leads fríos", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_accion_directa", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        conversationStateStore,
        sender,
        brokerAccionDirectaPlanner: stubBrokerAccionDirectaPlanner({
          actions: [
            { type: "whatsapp_send_message", leadId: "lead-1", phone: "5491100000001", message: "Bajamos el precio." },
            { type: "whatsapp_send_message", leadId: "lead-2", phone: "5491100000002", message: "Bajamos el precio." },
          ],
          previewSummary: "Bajamos el precio.",
        }),
      })
    );

    await handleIncomingMessage(
      incoming("mmm dejame pensarlo", BROKER_NUMBER),
      baseDeps({
        brokerWhatsappNumber: BROKER_NUMBER,
        conversationStateStore,
        sender,
        confirmationClassifier: stubConfirmationClassifier(false),
      })
    );

    expect(sentText).not.toHaveBeenCalled();
  });
});
