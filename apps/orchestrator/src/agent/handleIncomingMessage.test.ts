import { describe, expect, it, vi } from "vitest";
import type { Intent, IntentCatalog, Property } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { IntentClassification, IntentClassifier } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import { InMemoryAuditLogStore } from "./auditLog.js";
import { handleIncomingMessage, NotImplementedIntentError } from "./handleIncomingMessage.js";

const consultaDisponibilidad: Intent = {
  id: "consulta_disponibilidad",
  description: "El cliente pregunta si una propiedad sigue disponible.",
  channel: "cliente",
  priority: "high",
  triggers: { examples: ["¿el depto de Palermo sigue disponible?"] },
  tools: ["tokko.search_properties", "tokko.get_property"],
  requires_client_confirmation: false,
  requires_broker: false,
  confidence_threshold: 0.7,
  response: {
    style: "generative_grounded",
    grounding_fields: ["estado", "direccion", "tipo", "precio"],
    fallback_if_not_found: "No encontré esa propiedad.",
  },
};

const reclamoQueja: Intent = {
  id: "reclamo_queja",
  description: "Cualquier mensaje con tono de disconformidad, enojo o reclamo.",
  channel: "cliente",
  priority: "critical",
  triggers: { examples: ["esto es un desastre"] },
  tools: [],
  requires_client_confirmation: false,
  requires_broker: true,
  escalation_reason: "No usar respuesta genérica frente a disconformidad.",
  confidence_threshold: 0.6,
  response: {
    style: "template",
    template: "Entiendo, te voy a poner en contacto directo con el asesor.",
  },
};

const consultaPrecioCondiciones: Intent = {
  id: "consulta_precio_condiciones",
  description: "Precio, expensas, requisitos publicados.",
  channel: "cliente",
  priority: "high",
  triggers: { examples: ["¿cuánto sale el alquiler?"] },
  tools: ["tokko.get_property"],
  requires_client_confirmation: false,
  requires_broker: false,
  confidence_threshold: 0.75,
  response: { style: "generative_grounded", grounding_fields: ["precio"] },
};

const catalog: IntentCatalog = {
  version: 1,
  meta: {
    default_confidence_threshold: 0.75,
    escalation_channel: "broker_whatsapp",
    audit_log: true,
    language: "es-AR",
  },
  intents: [consultaDisponibilidad, reclamoQueja, consultaPrecioCondiciones],
};

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

function stubTokko(): TokkoQueries {
  return {
    searchProperties: vi.fn(async () => [property]),
    getProperty: vi.fn(async () => property),
  };
}

describe("handleIncomingMessage", () => {
  it("consulta_disponibilidad con confianza suficiente: ejecuta el handler y audita sin escalar", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const result = await handleIncomingMessage(incoming("¿el depto de Palermo sigue disponible?"), {
      catalog,
      classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.95, searchQuery: "Palermo" }),
      composer: stubComposer("Sigue disponible por $350.000."),
      tokko: stubTokko(),
      auditLog,
    });

    expect(result).toEqual({
      responseText: "Sigue disponible por $350.000.",
      intentId: "consulta_disponibilidad",
      confidence: 0.95,
      escalatedToBroker: false,
    });

    const [entry] = await auditLog.readAll();
    expect(entry).toMatchObject({
      matchedIntentId: "consulta_disponibilidad",
      confidence: 0.95,
      toolsCalled: ["tokko.search_properties", "tokko.get_property"],
      escalatedToBroker: false,
      responseSent: "Sigue disponible por $350.000.",
    });
  });

  it("requires_broker:true (reclamo_queja): responde con el template del intent, sin llamar tools", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const tokko = stubTokko();
    const composer = stubComposer();

    const result = await handleIncomingMessage(incoming("esto es un desastre, nadie me atiende"), {
      catalog,
      classifier: stubClassifier({ intentId: "reclamo_queja", confidence: 0.9 }),
      composer,
      tokko,
      auditLog,
    });

    expect(result.escalatedToBroker).toBe(true);
    expect(result.responseText).toBe(reclamoQueja.response.template);
    expect(tokko.searchProperties).not.toHaveBeenCalled();
    expect(composer.compose).not.toHaveBeenCalled();

    const [entry] = await auditLog.readAll();
    expect(entry.escalationReason).toBe(reclamoQueja.escalation_reason);
  });

  it("confianza por debajo del umbral del intent: escala aunque requires_broker sea false", async () => {
    const auditLog = new InMemoryAuditLogStore();
    const result = await handleIncomingMessage(incoming("che disponible?"), {
      catalog,
      classifier: stubClassifier({ intentId: "consulta_disponibilidad", confidence: 0.5 }),
      composer: stubComposer(),
      tokko: stubTokko(),
      auditLog,
    });

    expect(result.escalatedToBroker).toBe(true);
    // consulta_disponibilidad no define response.template -> cae al texto genérico
    expect(result.responseText).toMatch(/asesor/);
  });

  it("intent matcheado sin handler implementado todavía: tira NotImplementedIntentError", async () => {
    await expect(
      handleIncomingMessage(incoming("¿cuánto sale el alquiler?"), {
        catalog,
        classifier: stubClassifier({ intentId: "consulta_precio_condiciones", confidence: 0.9 }),
        composer: stubComposer(),
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
        tokko: stubTokko(),
        auditLog: new InMemoryAuditLogStore(),
      })
    ).rejects.toThrow(NotImplementedIntentError);
  });
});
