// La plantilla fija sale UNA vez por conversación; después el agente se calla
// hasta que el broker responda (docs/TASKS.md Bloque 31).
//
// Los tests están agrupados por modo de fallo del pre-mortem, porque son la
// única razón por la que existen: el comportamiento feliz es una línea, y todo
// lo demás es evitar que esto se rompa solo con el tiempo o con el Bloque 27.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  decidirPlantilla,
  plantillasFijas,
  DIAS_TECHO_SILENCIO,
  type EntradaPrevia,
} from "./plantillaRepetida.js";
import { handleIncomingMessage, type HandleMessageDeps } from "./handleIncomingMessage.js";
import { loadCatalog } from "./intentCatalog.js";
import { InMemoryAuditLogStore } from "./auditLog.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore } from "./conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./globalPauseStore.js";
import { InMemoryLastInteractionStore } from "./lastInteractionStore.js";
import { InMemoryUltimoContactoStore } from "./ultimoContactoStore.js";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { BrokerNotification, BrokerNotifier } from "./brokerNotifier.js";
import type { IntentClassification } from "./classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog(path.resolve(__dirname, "../../../..", "docs/intent_catalog.yaml"));

const AHORA = new Date("2026-08-28T15:00:00.000Z");
const haceHoras = (h: number) => new Date(AHORA.getTime() - h * 3600 * 1000).toISOString();

function notifierEspia(): BrokerNotifier & { notificaciones: BrokerNotification[] } {
  const notificaciones: BrokerNotification[] = [];
  return {
    notificaciones,
    notify: vi.fn(async (n: BrokerNotification) => {
      notificaciones.push(n);
    }),
  };
}

function deps(clasificacion: IntentClassification, overrides: Partial<HandleMessageDeps> = {}): HandleMessageDeps {
  return {
    catalog,
    classifier: { classify: vi.fn(async () => clasificacion) },
    composer: { compose: vi.fn(async () => "respuesta para el cliente") },
    draftComposer: { composeDraft: vi.fn(async () => "borrador sugerido") },
    tokko: {
      searchProperties: vi.fn(async () => []),
      getProperty: vi.fn(async () => null),
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
    // Apagado: la supresión sólo tiene sentido cuando el agente SÍ responde.
    modoSilencioso: false,
    ultimoContactoStore: new InMemoryUltimoContactoStore(),
    ...overrides,
  } as HandleMessageDeps;
}

let n = 0;
const mensaje = (text: string, from = "5491133339999"): IncomingWhatsAppMessage => ({
  from,
  messageId: "wamid." + (n += 1),
  text,
});

const FALLBACK = { intentId: "fallback_low_confidence", confidence: 0.2 };
const RECLAMO = { intentId: "reclamo_queja", confidence: 0.9 };

describe("qué cuenta como plantilla fija", () => {
  // Modo de fallo 4: si mañana alguien le agrega o le saca una variable a una
  // plantilla, el conjunto cambia en silencio y la supresión aplica donde no
  // debe. Este test fija la foto actual para que esa edición falle ruidosa.
  it("son exactamente las 7 del catálogo que no llevan variables", () => {
    expect([...plantillasFijas(catalog)].sort()).toEqual(
      [
        "consulta_legal_contractual",
        "derivacion_colega",
        "fallback_low_confidence",
        "hablar_con_persona",
        "negociacion_precio",
        "rechazo_desinteres",
        "reclamo_queja",
      ].sort()
    );
  });

  it("deja afuera las plantillas con variables, que llevan información real", () => {
    const fijas = plantillasFijas(catalog);
    // {direccion_corta}, {fecha_hora}, {accion}: el texto cambia en cada envío.
    for (const id of ["pedido_ficha_multimedia", "recordatorio_visita", "reprogramar_cancelar_visita"]) {
      expect(fijas.has(id)).toBe(false);
    }
  });

  // También del modo de fallo 4: la supresión está cableada en el camino de
  // escalamiento. Si alguien agrega una plantilla fija a un intent que NO
  // escala, se colaría por otro camino sin pasar por acá.
  it("todas escalan, que es el único camino donde está cableada la supresión", () => {
    const fijas = plantillasFijas(catalog);
    for (const intent of catalog.intents) {
      if (!fijas.has(intent.id)) continue;
      expect(intent.requires_broker, intent.id + " no escala").toBe(true);
    }
  });
});

describe("decidirPlantilla", () => {
  const fijas = plantillasFijas(catalog);
  const base = { fijas, ultimoContacto: null, ahora: AHORA };

  it("la primera vez sale", () => {
    expect(decidirPlantilla({ ...base, intentId: "fallback_low_confidence", historial: [] }).suprimir).toBe(false);
  });

  it("la segunda no", () => {
    const historial: EntradaPrevia[] = [
      { matchedIntentId: "fallback_low_confidence", timestamp: haceHoras(2), responseSent: "Dejame confirmarlo…" },
    ];
    expect(decidirPlantilla({ ...base, intentId: "fallback_low_confidence", historial }).suprimir).toBe(true);
  });

  // La decisión de que sea UNA por conversación y no una por intent: las 7
  // plantillas fijas dicen lo mismo, así que tres intents distintos serían
  // tres frases distintas con el mismo contenido.
  it("un intent fijo distinto tampoco vuelve a mandar", () => {
    const historial: EntradaPrevia[] = [
      { matchedIntentId: "fallback_low_confidence", timestamp: haceHoras(2), responseSent: "Dejame confirmarlo…" },
    ];
    expect(decidirPlantilla({ ...base, intentId: "negociacion_precio", historial }).suprimir).toBe(true);
  });

  it("una plantilla que ya se había suprimido no gasta el envío permitido", () => {
    // responseSent vacío = no le llegó nada al cliente.
    const historial: EntradaPrevia[] = [
      { matchedIntentId: "fallback_low_confidence", timestamp: haceHoras(2), responseSent: undefined },
    ];
    expect(decidirPlantilla({ ...base, intentId: "fallback_low_confidence", historial }).suprimir).toBe(false);
  });

  it("un intent que no es plantilla fija nunca se suprime", () => {
    const historial: EntradaPrevia[] = [
      { matchedIntentId: "fallback_low_confidence", timestamp: haceHoras(2), responseSent: "Dejame confirmarlo…" },
    ];
    expect(decidirPlantilla({ ...base, intentId: "consulta_disponibilidad", historial }).suprimir).toBe(false);
  });

  // Modo de fallo 1: el silencio no puede ser para siempre. La condición para
  // volver a hablar depende del eco de coexistencia, que es best-effort.
  describe("techo temporal (modo de fallo 1)", () => {
    it("pasado el techo vuelve a salir aunque no haya llegado ningún eco", () => {
      const historial: EntradaPrevia[] = [
        {
          matchedIntentId: "fallback_low_confidence",
          timestamp: haceHoras(24 * DIAS_TECHO_SILENCIO + 1),
          responseSent: "x",
        },
      ];
      expect(decidirPlantilla({ ...base, intentId: "fallback_low_confidence", historial }).suprimir).toBe(false);
    });

    it("justo antes del techo sigue callado", () => {
      const historial: EntradaPrevia[] = [
        {
          matchedIntentId: "fallback_low_confidence",
          timestamp: haceHoras(24 * DIAS_TECHO_SILENCIO - 1),
          responseSent: "x",
        },
      ];
      expect(decidirPlantilla({ ...base, intentId: "fallback_low_confidence", historial }).suprimir).toBe(true);
    });
  });

  // Modo de fallo 2: el propio sistema destrabando el silencio.
  describe("qué rompe el silencio (modo de fallo 2)", () => {
    const historial: EntradaPrevia[] = [
      { matchedIntentId: "fallback_low_confidence", timestamp: haceHoras(5), responseSent: "Dejame confirmarlo…" },
    ];

    it("el broker respondiendo a mano sí lo rompe", () => {
      const decision = decidirPlantilla({
        ...base,
        intentId: "fallback_low_confidence",
        historial,
        ultimoContacto: { leadId: "x", contactadoAt: haceHoras(1), origen: "manual" },
      });
      expect(decision.suprimir).toBe(false);
    });

    // El job de recontacto del Bloque 27 va a escribir `origen: "sistema"` en
    // el mismo store cuando se cablee. Si esto se mira sólo por fecha, el
    // recontacto automático cuenta como "el broker respondió" y la repetición
    // vuelve sin que nadie toque este archivo.
    it("un contacto automático del propio sistema NO lo rompe", () => {
      const decision = decidirPlantilla({
        ...base,
        intentId: "fallback_low_confidence",
        historial,
        ultimoContacto: { leadId: "x", contactadoAt: haceHoras(1), origen: "sistema" },
      });
      expect(decision.suprimir).toBe(true);
    });

    it("un contacto del broker ANTERIOR a la plantilla no cuenta", () => {
      const decision = decidirPlantilla({
        ...base,
        intentId: "fallback_low_confidence",
        historial,
        ultimoContacto: { leadId: "x", contactadoAt: haceHoras(9), origen: "manual" },
      });
      expect(decision.suprimir).toBe(true);
    });
  });
});

describe("cableado en handleIncomingMessage", () => {
  it("la primera plantilla sale y la segunda no", async () => {
    const d = deps(FALLBACK);

    const primera = await handleIncomingMessage(mensaje("???"), d);
    expect(primera.responseText).not.toBeNull();

    const segunda = await handleIncomingMessage(mensaje("hola?"), d);
    expect(segunda.responseText).toBeNull();
  });

  it("se sigue escalando al broker aunque no salga la plantilla", async () => {
    const notifier = notifierEspia();
    const d = deps(FALLBACK, { brokerNotifier: notifier });

    await handleIncomingMessage(mensaje("???"), d);
    await handleIncomingMessage(mensaje("hola?"), d);

    // Lo que separa "el agente se calla" de "el mensaje se pierde".
    expect(notifier.notificaciones).toHaveLength(2);
  });

  // Modo de fallo 3: el audit log es el registro de qué recibió cada persona.
  it("el audit log no dice que se envió algo que no se envió", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const d = deps(FALLBACK, { auditLog });

    await handleIncomingMessage(mensaje("???"), d);
    await handleIncomingMessage(mensaje("hola?"), d);

    const entradas = await auditLog.readAll();
    expect(entradas[0].responseSent).toBeTruthy();
    expect(entradas[1].responseSent).toBeUndefined();
    expect(entradas[1].escalatedToBroker).toBe(true);
    expect(entradas[1].escalationReason).toContain("Plantilla fija ya enviada");
  });

  it("es por conversación, no global", async () => {
    const d = deps(FALLBACK);

    await handleIncomingMessage(mensaje("???", "5491111111111"), d);
    const otra = await handleIncomingMessage(mensaje("???", "5492222222222"), d);

    expect(otra.responseText).not.toBeNull();
  });

  it("dos intents fijos distintos siguen contando como una sola plantilla", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const ultimoContactoStore = new InMemoryUltimoContactoStore();

    await handleIncomingMessage(mensaje("???"), deps(FALLBACK, { auditLog, ultimoContactoStore }));
    const segunda = await handleIncomingMessage(
      mensaje("esto es un desastre"),
      deps(RECLAMO, { auditLog, ultimoContactoStore })
    );

    expect(segunda.responseText).toBeNull();
  });

  it("después de que el broker responde, vuelve a salir", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const ultimoContactoStore = new InMemoryUltimoContactoStore();
    const d = deps(FALLBACK, { auditLog, ultimoContactoStore });

    await handleIncomingMessage(mensaje("???"), d);
    // El eco de coexistencia registrando que el broker escribió a mano.
    await ultimoContactoStore.registrar("5491133339999", new Date(Date.now() + 60_000), "manual");

    const despues = await handleIncomingMessage(mensaje("y entonces?"), d);
    expect(despues.responseText).not.toBeNull();
  });

  it("si no se puede leer el historial, se suprime (falla cerrado)", async () => {
    const auditLog = new InMemoryAuditLogStore();
    auditLog.readAll = vi.fn(async () => {
      throw new Error("disco lleno");
    });

    const resultado = await handleIncomingMessage(mensaje("???"), deps(FALLBACK, { auditLog }));
    expect(resultado.responseText).toBeNull();
  });
});
