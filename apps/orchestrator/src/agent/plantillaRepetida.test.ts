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
  frasesDeEspera,
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

/** Las frases de espera, por texto: es por ahí que se decide (Bloque 38e). */
const plantillaDe = (id: string) => catalog.intents.find((i) => i.id === id)!.response.template!;
const ESPERA = plantillaDe("fallback_low_confidence");
const ESPERA_NEGOCIACION = plantillaDe("negociacion_precio");
const DESPEDIDA = plantillaDe("rechazo_desinteres");

const FALLBACK = { intentId: "fallback_low_confidence", confidence: 0.2 };
const RECLAMO = { intentId: "reclamo_queja", confidence: 0.9 };

describe("qué cuenta como frase de espera", () => {
  // Modo de fallo 2 del Bloque 38e: si alguien agrega una frase de espera y no
  // la marca en el catálogo, se repite como antes del Bloque 31 y ninguna
  // métrica lo muestra. Este test fija la foto actual para que agregar una
  // obligue a mirar esta decisión.
  it("son exactamente las 6 marcadas en el catálogo", () => {
    const marcadas = catalog.intents.filter((i) => i.response.espera === true).map((i) => i.id);
    expect(marcadas.sort()).toEqual(
      [
        "consulta_legal_contractual",
        "derivacion_colega",
        "fallback_low_confidence",
        "hablar_con_persona",
        "negociacion_precio",
        "reclamo_queja",
      ].sort()
    );
  });

  // Modo de fallo 1 del Bloque 38e: una despedida también es texto fijo, y no
  // tiene por qué compartir el cupo con las frases de espera.
  it("la despedida de rechazo_desinteres no es una frase de espera", () => {
    expect(frasesDeEspera(catalog).has(DESPEDIDA)).toBe(false);
  });

  it("las plantillas con variables tampoco: su texto cambia en cada envío", () => {
    const esperas = frasesDeEspera(catalog);
    for (const id of ["pedido_ficha_multimedia", "recordatorio_visita", "reprogramar_cancelar_visita"]) {
      expect(esperas.has(plantillaDe(id))).toBe(false);
    }
  });
});

describe("decidirPlantilla", () => {
  const esperas = frasesDeEspera(catalog);
  const base = { esperas, ultimoContacto: null, ahora: AHORA };

  it("la primera vez sale", () => {
    expect(decidirPlantilla({ ...base, texto: ESPERA, historial: [] }).suprimir).toBe(false);
  });

  it("la segunda no", () => {
    const historial: EntradaPrevia[] = [
      { timestamp: haceHoras(2), responseSent: ESPERA },
    ];
    expect(decidirPlantilla({ ...base, texto: ESPERA, historial }).suprimir).toBe(true);
  });

  // La decisión de que sea UNA por conversación y no una por intent: las 7
  // plantillas fijas dicen lo mismo, así que tres intents distintos serían
  // tres frases distintas con el mismo contenido.
  it("un intent fijo distinto tampoco vuelve a mandar", () => {
    const historial: EntradaPrevia[] = [
      { timestamp: haceHoras(2), responseSent: ESPERA },
    ];
    expect(decidirPlantilla({ ...base, texto: ESPERA_NEGOCIACION, historial }).suprimir).toBe(true);
  });

  // docs/TASKS.md Bloque 38e: lo que gasta el cupo es haberle mandado una
  // FRASE DE ESPERA, no cualquier respuesta.
  it("una respuesta normal que ya salió no gasta el cupo de la frase de espera", () => {
    const historial: EntradaPrevia[] = [
      { timestamp: haceHoras(2), responseSent: "Sí, el de Palermo sigue disponible." },
    ];
    expect(decidirPlantilla({ ...base, texto: ESPERA, historial }).suprimir).toBe(false);
  });

  it("una plantilla que ya se había suprimido no gasta el envío permitido", () => {
    // responseSent vacío = no le llegó nada al cliente.
    const historial: EntradaPrevia[] = [
      { timestamp: haceHoras(2), responseSent: undefined },
    ];
    expect(decidirPlantilla({ ...base, texto: ESPERA, historial }).suprimir).toBe(false);
  });

  it("un intent que no es plantilla fija nunca se suprime", () => {
    const historial: EntradaPrevia[] = [
      { timestamp: haceHoras(2), responseSent: ESPERA },
    ];
    expect(decidirPlantilla({ ...base, texto: "Sí, sigue disponible.", historial }).suprimir).toBe(false);
  });

  // Modo de fallo 1: el silencio no puede ser para siempre. La condición para
  // volver a hablar depende del eco de coexistencia, que es best-effort.
  describe("techo temporal (modo de fallo 1)", () => {
    it("pasado el techo vuelve a salir aunque no haya llegado ningún eco", () => {
      const historial: EntradaPrevia[] = [
        {
          timestamp: haceHoras(24 * DIAS_TECHO_SILENCIO + 1),
          responseSent: ESPERA,
        },
      ];
      expect(decidirPlantilla({ ...base, texto: ESPERA, historial }).suprimir).toBe(false);
    });

    it("justo antes del techo sigue callado", () => {
      const historial: EntradaPrevia[] = [
        {
          timestamp: haceHoras(24 * DIAS_TECHO_SILENCIO - 1),
          responseSent: ESPERA,
        },
      ];
      expect(decidirPlantilla({ ...base, texto: ESPERA, historial }).suprimir).toBe(true);
    });
  });

  // Modo de fallo 2: el propio sistema destrabando el silencio.
  describe("qué rompe el silencio (modo de fallo 2)", () => {
    const historial: EntradaPrevia[] = [
      { timestamp: haceHoras(5), responseSent: ESPERA },
    ];

    it("el broker respondiendo a mano sí lo rompe", () => {
      const decision = decidirPlantilla({
        ...base,
        texto: ESPERA,
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
        texto: ESPERA,
        historial,
        ultimoContacto: { leadId: "x", contactadoAt: haceHoras(1), origen: "sistema" },
      });
      expect(decision.suprimir).toBe(true);
    });

    it("un contacto del broker ANTERIOR a la plantilla no cuenta", () => {
      const decision = decidirPlantilla({
        ...base,
        texto: ESPERA,
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
    // Hallazgo de la revisión del Bloque 31: la supresión pisaba el motivo
    // real del escalamiento. Ahora va en su propio campo.
    expect(entradas[1].supresion).toContain("frase de espera");
    expect(entradas[1].escalationReason).toBe(
      catalog.intents.find((i) => i.id === "fallback_low_confidence")!.escalation_reason
    );
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

  // docs/TASKS.md Bloque 38e: desde 38c, un escalamiento por baja confianza de
  // cualquier intent manda la misma frase de espera. Antes no contaba para el
  // cupo, porque la supresión miraba el intent.
  it("un escalamiento por baja confianza de otro intent también gasta el cupo", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const ultimoContactoStore = new InMemoryUltimoContactoStore();
    const baja = { intentId: "consulta_disponibilidad", confidence: 0.2, searchQuery: "Palermo" };

    const primera = await handleIncomingMessage(mensaje("¿sigue?"), deps(baja, { auditLog, ultimoContactoStore }));
    const segunda = await handleIncomingMessage(mensaje("hola?"), deps(FALLBACK, { auditLog, ultimoContactoStore }));

    expect(primera.responseText).toBe(ESPERA);
    expect(segunda.responseText).toBeNull();
  });

  it("la despedida sale aunque ya se le haya mandado una frase de espera", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const ultimoContactoStore = new InMemoryUltimoContactoStore();
    const rechazo = { intentId: "rechazo_desinteres", confidence: 0.9 };

    await handleIncomingMessage(mensaje("???"), deps(FALLBACK, { auditLog, ultimoContactoStore }));
    const segunda = await handleIncomingMessage(mensaje("no me interesa"), deps(rechazo, { auditLog, ultimoContactoStore }));

    expect(segunda.responseText).toBe(DESPEDIDA);
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
