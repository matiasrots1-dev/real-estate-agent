import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntentCatalog, Property } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { WeatherQueries } from "../mcp/weatherMcpClient.js";
import type { IntentClassification, IntentClassifier } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { DraftReplyComposer } from "./draftComposer.js";
import { formatBrokerNotificationText, type BrokerNotifier, type BrokerNotification } from "./brokerNotifier.js";
import { InMemoryAuditLogStore } from "./auditLog.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore, idleState } from "./conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./globalPauseStore.js";
import { InMemoryLastInteractionStore } from "./lastInteractionStore.js";
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
    // Devuelve un lead resoluble: desde el Bloque 16 el executor de
    // broker_accion_directa resuelve el teléfono acá, porque el plan que
    // arma Claude ya no lo trae.
    getLead: vi.fn(async (id: string) => ({
      id,
      tokkoId: "tokko-" + id,
      nombre: "Lead de Prueba",
      telefonoWhatsapp: "5491100000001",
      temperatura: "frio" as const,
      propiedadesDeInteres: [],
      diasSinRespuesta: 45,
    })),
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
    lastInteractionStore: new InMemoryLastInteractionStore(),
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

// docs/TASKS.md Bloque 38a. Antes el borrador y el aviso iban en el mismo
// `try`: si fallaba el borrador, el broker no recibía nada.
describe("handleIncomingMessage — el aviso al broker no depende del borrador (Bloque 38a)", () => {
  function borradorQueFalla(): DraftReplyComposer {
    return {
      composeDraft: vi.fn(async () => {
        throw new Error("529 Overloaded");
      }),
    };
  }

  it("si el borrador falla, el aviso sale igual, sin borrador y con el motivo", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const brokerNotifier = recordingBrokerNotifier();

    const result = await handleIncomingMessage(
      incoming("esto es un desastre"),
      baseDeps({
        classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }),
        draftComposer: borradorQueFalla(),
        brokerNotifier,
        auditLog,
      })
    );

    expect(brokerNotifier.notify).toHaveBeenCalledTimes(1);
    expect(brokerNotifier.notifications[0]).toMatchObject({ matchedIntentId: "reclamo_queja", draftReply: null });
    expect(brokerNotifier.notifications[0].motivoFalloBorrador).toContain("529 Overloaded");
    // Lo que recibe el cliente no cambia.
    const reclamoQueja = catalog.intents.find((i) => i.id === "reclamo_queja");
    expect(result.responseText).toBe(reclamoQueja?.response.template);
    const [entry] = await auditLog.readAll();
    expect(entry.avisoAlBroker).toBe("sin_borrador");
    expect(entry.avisoAlBrokerMotivo).toContain("529 Overloaded");
  });

  // En modo silencioso el aviso es lo único que produce el bot. Hallazgo de la
  // revisión del PR: el aviso decía "Este borrador es para que respondas vos"
  // justo arriba de "Sin borrador".
  it("en modo silencioso también, y el aviso no se contradice", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const brokerNotifier = recordingBrokerNotifier();

    await handleIncomingMessage(
      incoming("esto es un desastre"),
      baseDeps({
        classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }),
        draftComposer: borradorQueFalla(),
        brokerNotifier,
        auditLog,
        modoSilencioso: true,
      })
    );

    expect(brokerNotifier.notify).toHaveBeenCalledTimes(1);
    expect(brokerNotifier.notifications[0].draftReply).toBeNull();
    const texto = formatBrokerNotificationText(brokerNotifier.notifications[0]);
    expect(texto).toContain("Sin borrador");
    expect(texto).not.toContain("Este borrador");
    const [entry] = await auditLog.readAll();
    expect(entry.avisoAlBroker).toBe("sin_borrador");
  });

  // El motivo del modo silencioso va en el camino que no escala. Sin respaldo
  // (la respuesta quedó vacía), el aviso no puede decir "este borrador" arriba
  // de "sin borrador".
  it("en modo silencioso, sin borrador ni respaldo, el motivo no habla de un borrador", async () => {
    const brokerNotifier = recordingBrokerNotifier();

    await handleIncomingMessage(
      incoming("¿el depto de Palermo sigue disponible?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        composer: stubComposer(""),
        draftComposer: borradorQueFalla(),
        brokerNotifier,
        modoSilencioso: true,
      })
    );

    expect(brokerNotifier.notifications[0].draftReply).toBeNull();
    const texto = formatBrokerNotificationText(brokerNotifier.notifications[0]);
    expect(texto).toContain("Modo silencioso");
    expect(texto).toContain("Sin borrador");
    expect(texto).not.toContain("Este borrador");
  });

  // Hallazgo de la revisión del PR: en modo silencioso el bot ya tiene la
  // respuesta que habría mandado, armada con los datos de Tokko.
  it("en modo silencioso, si el borrador falla, va la respuesta que el bot habría mandado", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const brokerNotifier = recordingBrokerNotifier();

    await handleIncomingMessage(
      incoming("¿el depto de Palermo sigue disponible?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        composer: stubComposer("Sigue disponible por $350.000."),
        draftComposer: borradorQueFalla(),
        brokerNotifier,
        auditLog,
        modoSilencioso: true,
      })
    );

    expect(brokerNotifier.notifications[0]).toMatchObject({ draftReply: "Sigue disponible por $350.000." });
    expect(brokerNotifier.notifications[0].motivoFalloBorrador).toContain("529 Overloaded");
    const [entry] = await auditLog.readAll();
    expect(entry.avisoAlBroker).toBe("respaldo");
    expect(entry.responseSent).toBeUndefined();
  });

  // Hallazgo de la revisión del PR: un borrador vacío salía como "Borrador
  // sugerido:" seguido de nada, y quedaba como enviado.
  it("un borrador vacío cuenta como falla", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const brokerNotifier = recordingBrokerNotifier();

    await handleIncomingMessage(
      incoming("esto es un desastre"),
      baseDeps({
        classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }),
        draftComposer: stubDraftComposer("   "),
        brokerNotifier,
        auditLog,
      })
    );

    expect(brokerNotifier.notifications[0].draftReply).toBeNull();
    const [entry] = await auditLog.readAll();
    expect(entry.avisoAlBroker).toBe("sin_borrador");
    expect(entry.avisoAlBrokerMotivo).toContain("vacío");
  });

  it("si el aviso no se puede mandar, el mensaje no falla y el audit log lo dice", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const brokerNotifier: BrokerNotifier = {
      notify: vi.fn(async () => {
        throw new Error("WhatsApp Cloud API caída");
      }),
    };

    await expect(
      handleIncomingMessage(
        incoming("esto es un desastre"),
        baseDeps({ classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }), brokerNotifier, auditLog })
      )
    ).resolves.toBeDefined();

    const [entry] = await auditLog.readAll();
    expect(entry.escalatedToBroker).toBe(true);
    expect(entry.avisoAlBroker).toBe("fallo");
    expect(entry.avisoAlBrokerMotivo).toContain("WhatsApp Cloud API caída");
  });

  it("con borrador, el audit log registra el aviso como enviado", async () => {
    const auditLog = new InMemoryAuditLogStore();

    await handleIncomingMessage(
      incoming("esto es un desastre"),
      baseDeps({
        classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }),
        brokerNotifier: recordingBrokerNotifier(),
        auditLog,
      })
    );

    const [entry] = await auditLog.readAll();
    expect(entry.avisoAlBroker).toBe("enviado");
  });

  // Hallazgo de la revisión del PR: sin número del broker, la entrada no se
  // distinguía de una anterior al Bloque 38a.
  it("sin número del broker, el audit log dice que nadie se enteró", async () => {
    const auditLog = new InMemoryAuditLogStore();

    await handleIncomingMessage(
      incoming("esto es un desastre"),
      baseDeps({ classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }), auditLog })
    );

    const [entry] = await auditLog.readAll();
    expect(entry.avisoAlBroker).toBe("sin_destinatario");
  });

  it("un mensaje que no escala no registra aviso", async () => {
    const auditLog = new InMemoryAuditLogStore();

    await handleIncomingMessage(
      incoming("¿el depto de Palermo sigue disponible?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        brokerNotifier: recordingBrokerNotifier(),
        auditLog,
      })
    );

    const [entry] = await auditLog.readAll();
    expect(entry.avisoAlBroker).toBeUndefined();
  });
});

// docs/TASKS.md Bloque 38c. Un escalamiento por baja confianza respondía con
// la plantilla del propio intent: para los que no escalan solos, la del caso
// exitoso, con los huecos sin llenar.
describe("handleIncomingMessage — ningún escalamiento manda una plantilla con huecos (Bloque 38c)", () => {
  // Hallazgo de la revisión del PR #40: un expect que falla antes del
  // mockRestore dejaba console.error mockeado para el resto del archivo.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ESPERA = catalog.intents.find((i) => i.id === catalog.meta.escalation_waiting_template_from)!.response
    .template!;

  // Todos los intents del catálogo real, con confianza baja: el próximo que se
  // agregue con una plantilla con huecos también queda cubierto.
  it.each(catalog.intents.map((i) => [i.id, i.channel] as const))(
    '"%s" con confianza baja responde sin huecos',
    async (intentId, channel) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const from = channel === "broker" ? BROKER_NUMBER : "5491100000001";
      const result = await handleIncomingMessage(
        incoming("algo que no se entiende bien", from),
        baseDeps({ classifier: stubClassifier({ intentId, confidence: 0.1 }), brokerWhatsappNumber: BROKER_NUMBER })
      );

      expect(result.escalatedToBroker).toBe(true);
      expect(result.responseText ?? "").not.toMatch(/\{[a-z_]+\}/);
      // Sin la red de última línea: el camino conocido ya elige bien. Si la
      // red tuviera que actuar acá, estaría tapando una regresión.
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining("[respuesta]"));
      error.mockRestore();
    }
  );

  it("reprogramar_cancelar_visita con confianza baja recibe la plantilla de espera, no \"Listo, ...\"", async () => {
    const result = await handleIncomingMessage(
      incoming("¿lo podemos mover?"),
      baseDeps({ classifier: stubClassifier({ intentId: "reprogramar_cancelar_visita", confidence: 0.4 }) })
    );

    expect(result.responseText).toBe(ESPERA);
  });

  it("un intent que escala siempre sigue respondiendo con su propia plantilla de espera", async () => {
    const negociacion = catalog.intents.find((i) => i.id === "negociacion_precio")!;
    const result = await handleIncomingMessage(
      incoming("¿me hacés un descuento?"),
      baseDeps({ classifier: stubClassifier({ intentId: "negociacion_precio", confidence: 0.9 }) })
    );

    expect(result.responseText).toBe(negociacion.response.template);
    expect(result.responseText).not.toBe(ESPERA);
  });

  // Modo de fallo 2 del pre-mortem: la red de última línea.
  // Hallazgo de la revisión del PR #40: la plantilla de espera le promete al
  // cliente que el asesor le va a responder. Si la red solo cambiaba el texto,
  // nadie le avisaba al broker.
  it("una respuesta con un hueco sin llenar no le llega al cliente, y el mensaje escala de verdad", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const auditLog = new InMemoryAuditLogStore();
    const brokerNotifier = recordingBrokerNotifier();

    const result = await handleIncomingMessage(
      incoming("¿sigue disponible?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        composer: stubComposer("Sí, el de {direccion_corta} sigue disponible."),
        auditLog,
        brokerNotifier,
      })
    );

    expect(result.responseText).toBe(ESPERA);
    expect(result.escalatedToBroker).toBe(true);
    expect(result.mediaUrls).toBeUndefined();
    expect(brokerNotifier.notify).toHaveBeenCalledTimes(1);
    expect(brokerNotifier.notifications[0].escalationReason).toContain("datos sin completar");
    const [entry] = await auditLog.readAll();
    expect(entry.responseSent).toBe(ESPERA);
    expect(entry.escalatedToBroker).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("consulta_disponibilidad"));
  });

  it("un hueco con tilde o mayúscula también cuenta", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleIncomingMessage(
      incoming("¿sigue disponible?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        composer: stubComposer("Sí, el de {dirección} sigue disponible, {Nombre}."),
      })
    );

    expect(result.responseText).toBe(ESPERA);
  });

  // Hallazgo de la revisión del PR #40: un "ok" del cliente no puede confirmar
  // horarios que nunca leyó.
  it("si la red corta una propuesta de horarios, la conversación no queda esperando confirmación", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const conversationStateStore = new InMemoryConversationStateStore();

    const result = await handleIncomingMessage(
      incoming("quiero ir a ver el de Palermo"),
      baseDeps({
        classifier: stubClassifier({ intentId: "agendar_visita", confidence: 0.95, searchQuery: "Palermo" }),
        composer: stubComposer("Tengo estos horarios para {direccion_corta}: jueves 10, viernes 11."),
        conversationStateStore,
      })
    );

    expect(result.responseText).toBe(ESPERA);
    expect(result.escalatedToBroker).toBe(true);
    const estado = await conversationStateStore.get("5491100000001");
    expect(estado?.step ?? "idle").toBe("idle");
  });

  // Modo de fallo 3 del pre-mortem: llaves con otro contenido no son un hueco.
  it("llaves que no son un hueco del catálogo pasan", async () => {
    const texto = "Sale {USD 350.000} y tiene cochera {opcional: 1}.";

    const result = await handleIncomingMessage(
      incoming("¿cuánto sale?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        composer: stubComposer(texto),
      })
    );

    expect(result.responseText).toBe(texto);
  });

  // Hallazgo de la revisión del PR #40: el preview de una orden masiva cita
  // el mensaje con {nombre}, que se reemplaza al mandarlo. Cortarlo le
  // escondía el preview al broker y dejaba el plan esperando su "dale".
  it("en el canal broker la red no actúa: el {nombre} de un preview es legítimo", async () => {
    const acciones = ["lead-1", "lead-2"].map((leadId) => ({
      type: "whatsapp_send_message" as const,
      leadId,
      message: "Hola {nombre}, bajamos el precio.",
    }));

    const result = await handleIncomingMessage(
      incoming("avisales a los leads fríos que bajamos el precio", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_accion_directa", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        brokerAccionDirectaPlanner: stubBrokerAccionDirectaPlanner({
          actions: acciones,
          previewSummary: 'Les mando "Hola {nombre}, bajamos el precio."',
        }),
      })
    );

    expect(result.responseText).toContain("{nombre}");
    expect(result.responseText).toMatch(/confirmás/i);
    expect(result.escalatedToBroker).toBe(false);
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

  // docs/TASKS.md Bloque 38g. Antes, en modo silencioso, el broker pedía un
  // resumen y recibía un "Escalamiento" con un borrador sobre su propio mensaje.
  it("en modo silencioso, la orden del broker recibe su respuesta y no un escalamiento", async () => {
    const gcal = stubGcal();
    gcal.listEvents = vi.fn(async () => []);
    const brokerNotifier = recordingBrokerNotifier();
    const auditLog = new InMemoryAuditLogStore();

    const result = await handleIncomingMessage(
      incoming("¿cómo viene la agenda?", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_resumen_agenda", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        gcal,
        composer: stubComposer("No tenés visitas esta semana."),
        brokerNotifier,
        auditLog,
        modoSilencioso: true,
      })
    );

    expect(result.responseText).toBe("No tenés visitas esta semana.");
    expect(brokerNotifier.notify).not.toHaveBeenCalled();
    const [entry] = await auditLog.readAll();
    // Se le mandó de verdad: el audit log lo registra como enviado.
    expect(entry.responseSent).toBe("No tenés visitas esta semana.");
  });

  // Hallazgo de la revisión del PR #37: la excepción para el broker también se
  // aplicaba a los escalamientos, y una orden del broker que no se entendió le
  // devolvía la plantilla del intent, por ejemplo "Listo, {accion} para
  // {alcance}.", que se lee como que la orden se ejecutó.
  it("en modo silencioso, una orden del broker que escala no le devuelve la plantilla", async () => {
    const brokerNotifier = recordingBrokerNotifier();

    const result = await handleIncomingMessage(
      incoming("reactivá el agente", BROKER_NUMBER),
      baseDeps({
        classifier: stubClassifier({ intentId: "broker_pausar_agente", confidence: 0.3 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        brokerNotifier,
        modoSilencioso: true,
      })
    );

    expect(result.escalatedToBroker).toBe(true);
    expect(result.responseText).toBeNull();
    // Se entera por el aviso del escalamiento, con la confianza.
    expect(brokerNotifier.notify).toHaveBeenCalledTimes(1);
  });

  // Hallazgo de la revisión del PR #37: el ruteo comparaba el texto exacto y el
  // modo silencioso solo los dígitos. Con "+54 9 ..." en la configuración,
  // las órdenes del broker se ruteaban como de un cliente.
  it("el número del broker configurado con + y espacios igual se reconoce", async () => {
    const classifier = capturingClassifier({ intentId: "broker_resumen_agenda", confidence: 0.9 });
    const gcal = stubGcal();
    gcal.listEvents = vi.fn(async () => []);

    await handleIncomingMessage(
      incoming("¿cómo viene la agenda?", BROKER_NUMBER),
      baseDeps({ classifier, gcal, brokerWhatsappNumber: "+54 9 11 9999-9999" })
    );

    expect(classifier.seenCatalog!.intents.some((i) => i.channel === "broker")).toBe(true);
  });

  it("con el número del broker vacío en la configuración, nadie es el broker", async () => {
    const classifier = capturingClassifier({ intentId: "consulta_disponibilidad", confidence: 0.9, searchQuery: "x" });

    await handleIncomingMessage(incoming("hola", ""), baseDeps({ classifier, brokerWhatsappNumber: "" }));

    expect(classifier.seenCatalog!.intents.some((i) => i.channel === "broker")).toBe(false);
  });

  // Modo de fallo 3 del pre-mortem: la excepción no puede alcanzar a un cliente.
  it("en modo silencioso, un cliente sigue sin recibir respuesta, con número de broker configurado", async () => {
    const result = await handleIncomingMessage(
      incoming("¿el depto de Palermo sigue disponible?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        brokerWhatsappNumber: BROKER_NUMBER,
        brokerNotifier: recordingBrokerNotifier(),
        modoSilencioso: true,
      })
    );

    expect(result.responseText).toBeNull();
  });

  it("en modo silencioso, un cliente sigue sin recibir respuesta, sin número de broker configurado", async () => {
    const result = await handleIncomingMessage(
      incoming("¿el depto de Palermo sigue disponible?"),
      baseDeps({
        classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
        modoSilencioso: true,
      })
    );

    expect(result.responseText).toBeNull();
  });

  it("en modo silencioso, un escalamiento del cliente sigue sin plantilla", async () => {
    const result = await handleIncomingMessage(
      incoming("esto es un desastre"),
      baseDeps({
        classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }),
        brokerWhatsappNumber: BROKER_NUMBER,
        brokerNotifier: recordingBrokerNotifier(),
        modoSilencioso: true,
      })
    );

    expect(result.responseText).toBeNull();
    expect(result.escalatedToBroker).toBe(true);
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
      { type: "whatsapp_send_message" as const, leadId: "lead-1", message: "Bajamos el precio." },
      { type: "whatsapp_send_message" as const, leadId: "lead-2", message: "Bajamos el precio." },
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
          actions: [{ type: "whatsapp_send_message", leadId: "lead-1", message: "Hola Juan!" }],
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
            { type: "whatsapp_send_message", leadId: "lead-1", message: "Bajamos el precio." },
            { type: "whatsapp_send_message", leadId: "lead-2", message: "Bajamos el precio." },
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
            { type: "whatsapp_send_message", leadId: "lead-1", message: "Bajamos el precio." },
            { type: "whatsapp_send_message", leadId: "lead-2", message: "Bajamos el precio." },
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

// docs/TASKS.md Bloque 42. La línea del bot es la línea de trabajo real del
// broker: por ahí entran amigos, la universidad, proveedores. Sin esto, un
// "Jajajaja" cae en fallback, escala, y el amigo recibe "Dejame confirmarlo
// con el asesor y te respondo enseguida".
describe("handleIncomingMessage — el bot se calla con lo que no es del negocio (Bloque 42)", () => {
  const AJENO = { intentId: "conversacion_ajena_al_negocio", confidence: 0.95 };

  it("no responde, no escala y no avisa", async () => {
    const notifier = recordingBrokerNotifier();
    const deps = baseDeps({ classifier: stubClassifier(AJENO), brokerNotifier: notifier });

    const r = await handleIncomingMessage(incoming("Jajajaja"), deps);

    expect(r.responseText).toBeNull();
    expect(r.escalatedToBroker).toBe(false);
    expect(notifier.notifications).toHaveLength(0);
  });

  // Modo de fallo 2: si el silencio se cuela por el camino del escalamiento,
  // el amigo recibe la frase de espera y el bloque no sirvió de nada.
  it("el audit log no dice que se le mandó nada", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const deps = baseDeps({ classifier: stubClassifier(AJENO), auditLog });

    await handleIncomingMessage(incoming("Jajajaja"), deps);

    const [entrada] = await auditLog.readAll();
    expect(entrada).toMatchObject({
      matchedIntentId: "conversacion_ajena_al_negocio",
      escalatedToBroker: false,
    });
    expect(entrada.responseSent).toBeUndefined();
    expect(entrada.avisoAlBroker).toBeUndefined();
  });

  // Modo de fallo 1: callarse con un cliente de verdad no deja rastro. Por eso
  // sólo se hace con confianza; si el clasificador duda, gana el camino normal.
  it("con confianza por debajo del umbral NO se calla: escala como siempre", async () => {
    const notifier = recordingBrokerNotifier();
    const deps = baseDeps({
      classifier: stubClassifier({ intentId: "conversacion_ajena_al_negocio", confidence: 0.4 }),
      brokerNotifier: notifier,
    });

    const r = await handleIncomingMessage(incoming("mmm"), deps);

    expect(r.escalatedToBroker).toBe(true);
    expect(r.responseText).not.toBeNull();
    expect(notifier.notifications).toHaveLength(1);
  });

  it("el umbral de este intent es el más alto del catálogo, y es a propósito", () => {
    const intent = catalog.intents.find((i) => i.id === "conversacion_ajena_al_negocio");
    const umbrales = catalog.intents
      .map((i) => i.confidence_threshold)
      .filter((u): u is number => typeof u === "number");

    expect(intent?.confidence_threshold).toBe(Math.max(...umbrales));
  });

  // Modo de fallo 3: `silencio` es la única forma de que el bot no conteste.
  // Este test fija cuáles intents lo usan, para que agregar otro obligue a
  // mirar esta decisión (mismo criterio que `espera` en el Bloque 38e).
  it("sólo un intent del catálogo es de silencio", () => {
    const ids = catalog.intents.filter((i) => i.response.style === "silencio").map((i) => i.id);
    expect(ids).toEqual(["conversacion_ajena_al_negocio"]);
  });
});
