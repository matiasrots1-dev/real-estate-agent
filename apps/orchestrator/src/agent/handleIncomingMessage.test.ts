import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IntentCatalog, Property } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { IntentClassification, IntentClassifier } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { DraftReplyComposer } from "./draftComposer.js";
import type { BrokerNotifier, BrokerNotification } from "./brokerNotifier.js";
import { InMemoryAuditLogStore } from "./auditLog.js";
import { loadCatalog } from "./intentCatalog.js";
import { handleIncomingMessage, NotImplementedIntentError } from "./handleIncomingMessage.js";

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
};

function incoming(text: string): IncomingWhatsAppMessage {
  return { from: "5491100000001", messageId: "wamid.abc", text };
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
      const tokko = stubTokko();
      const composer = stubComposer();
      const draftComposer = stubDraftComposer("Hola! Dejame confirmarte eso.");
      const brokerNotifier = recordingBrokerNotifier();
      const intent = catalog.intents.find((i) => i.id === intentId);
      if (!intent) throw new Error(`Intent "${intentId}" no está en el catálogo real — revisar el test.`);

      const result = await handleIncomingMessage(incoming("mensaje de prueba"), {
        catalog,
        classifier: stubClassifier({ intentId, confidence: 0.9 }),
        composer,
        draftComposer,
        tokko,
        auditLog,
        brokerNotifier,
      });

      expect(intent.requires_broker).toBe(true);
      expect(result.escalatedToBroker).toBe(true);
      expect(result.responseText).toBe(intent.response.template);
      expect(tokko.searchProperties).not.toHaveBeenCalled();
      expect(composer.compose).not.toHaveBeenCalled();

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
    const brokerNotifier = recordingBrokerNotifier();

    const result = await handleIncomingMessage(incoming("che disponible?"), {
      catalog,
      classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.5 }),
      composer: stubComposer(),
      draftComposer: stubDraftComposer(),
      tokko: stubTokko(),
      auditLog,
      brokerNotifier,
    });

    expect(result.escalatedToBroker).toBe(true);
    expect(result.responseText).toMatch(/asesor/);
    const [entry] = await auditLog.readAll();
    expect(entry.escalationRule).toBe("low_confidence");
    expect(brokerNotifier.notify).toHaveBeenCalledTimes(1);
  });

  it("sin brokerNotifier configurado: igual escala y responde al cliente, solo que no notifica a nadie", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const result = await handleIncomingMessage(incoming("quiero hablar con una persona"), {
      catalog,
      classifier: stubClassifier({ intentId: "hablar_con_persona", confidence: 0.95 }),
      composer: stubComposer(),
      draftComposer: stubDraftComposer(),
      tokko: stubTokko(),
      auditLog,
      // brokerNotifier omitido a propósito
    });

    expect(result.escalatedToBroker).toBe(true);
    const [entry] = await auditLog.readAll();
    expect(entry.escalatedToBroker).toBe(true);
  });

  it("si notificar al broker falla, el cliente igual recibe su respuesta (best-effort, no rompe el loop)", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const brokerNotifier: BrokerNotifier = {
      notify: vi.fn(async () => {
        throw new Error("WhatsApp Cloud API caída");
      }),
    };

    const result = await handleIncomingMessage(incoming("esto es un desastre"), {
      catalog,
      classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }),
      composer: stubComposer(),
      draftComposer: stubDraftComposer(),
      tokko: stubTokko(),
      auditLog,
      brokerNotifier,
    });

    const reclamoQueja = catalog.intents.find((i) => i.id === "reclamo_queja");
    expect(result.responseText).toBe(reclamoQueja?.response.template);
    expect(result.escalatedToBroker).toBe(true);
  });
});

describe("handleIncomingMessage — consulta_disponibilidad (Bloque 3, sigue funcionando)", () => {
  it("con confianza suficiente: ejecuta el handler, no escala, no notifica al broker", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const draftComposer = stubDraftComposer();
    const brokerNotifier = recordingBrokerNotifier();

    const result = await handleIncomingMessage(incoming("¿el depto de Palermo sigue disponible?"), {
      catalog,
      classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
      composer: stubComposer("Sigue disponible por $350.000."),
      draftComposer,
      tokko: stubTokko(),
      auditLog,
      brokerNotifier,
    });

    expect(result).toEqual({
      responseText: "Sigue disponible por $350.000.",
      intentId: "consulta_disponibilidad",
      confidence: 0.95,
      escalatedToBroker: false,
    });
    expect(draftComposer.composeDraft).not.toHaveBeenCalled();
    expect(brokerNotifier.notify).not.toHaveBeenCalled();

    const [entry] = await auditLog.readAll();
    expect(entry).toMatchObject({
      matchedIntentId: "consulta_disponibilidad",
      toolsCalled: ["tokko.search_properties", "tokko.get_property"],
      escalatedToBroker: false,
      escalationRule: undefined,
    });
  });
});

describe("handleIncomingMessage — intents sin handler todavía", () => {
  it('"conditional" (agendar_visita) con confianza suficiente: tira NotImplementedIntentError', async () => {
    await expect(
      handleIncomingMessage(incoming("quiero ir a verlo el sábado"), {
        catalog,
        classifier: stubClassifier({ intentId: "agendar_visita", confidence: 0.9 }),
        composer: stubComposer(),
        draftComposer: stubDraftComposer(),
        tokko: stubTokko(),
        auditLog: new InMemoryAuditLogStore(),
      })
    ).rejects.toThrow(NotImplementedIntentError);
  });

  it("intent reactivo de Bloque 5 (consulta_precio_condiciones) con confianza suficiente: tira NotImplementedIntentError", async () => {
    await expect(
      handleIncomingMessage(incoming("¿cuánto sale el alquiler?"), {
        catalog,
        classifier: stubClassifier({ intentId: "consulta_precio_condiciones", confidence: 0.9 }),
        composer: stubComposer(),
        draftComposer: stubDraftComposer(),
        tokko: stubTokko(),
        auditLog: new InMemoryAuditLogStore(),
      })
    ).rejects.toThrow(NotImplementedIntentError);
  });

  it("intent inexistente en el catálogo (alucinación del classifier): tira NotImplementedIntentError", async () => {
    await expect(
      handleIncomingMessage(incoming("mensaje raro"), {
        catalog,
        classifier: stubClassifier({ intentId: "intent_que_no_existe", confidence: 0.9 }),
        composer: stubComposer(),
        draftComposer: stubDraftComposer(),
        tokko: stubTokko(),
        auditLog: new InMemoryAuditLogStore(),
      })
    ).rejects.toThrow(NotImplementedIntentError);
  });
});
