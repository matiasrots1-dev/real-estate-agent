// Hito de validación del Bloque 3 (docs/TASKS.md): un mensaje de WhatsApp
// de prueba dispara consulta_disponibilidad de punta a punta contra
// mcp-tokko REAL (proceso hijo real por stdio, protocolo MCP real, sin
// mockear esta capa) y queda registrado en audit_log.
//
// Lo único stubbeado acá es lo que depende de ANTHROPIC_API_KEY (todavía
// no configurada en este entorno, ver CLAUDE.md secc. 5): la clasificación
// de intent y la redacción final. Correr esto con la clave real y
// ClaudeIntentClassifier/ClaudeResponseComposer de verdad, apuntando al
// mismo webhook, es el próximo paso manual sugerido (ver mensaje final del
// bloque).

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequestListener } from "./app.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { InMemoryAuditLogStore } from "./agent/auditLog.js";
import { InMemoryAppointmentStore } from "./agent/appointmentStore.js";
import { InMemoryConversationStateStore } from "./agent/conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./agent/globalPauseStore.js";
import { TokkoMcpClient } from "./mcp/tokkoMcpClient.js";
import type { GcalQueries } from "./mcp/gcalMcpClient.js";
import type { WeatherQueries } from "./mcp/weatherMcpClient.js";
import type { IntentClassifier } from "./agent/classifier.js";
import type { ResponseComposer } from "./agent/composer.js";
import type { DraftReplyComposer } from "./agent/draftComposer.js";
import type { BrokerNotifier, BrokerNotification } from "./agent/brokerNotifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const APP_SECRET = "test-app-secret";
const WEBHOOK_VERIFY_TOKEN = "test-verify-token";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function metaTextMessagePayload(from: string, text: string) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "111222333" },
              messages: [
                {
                  from,
                  id: "wamid.test123",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

/**
 * Stub: reemplaza la clasificación real de Claude (requiere ANTHROPIC_API_KEY).
 * Rama por contenido del mensaje para poder ejercitar tanto el camino de
 * consulta_disponibilidad (Bloque 3) como el de escalamiento (Bloque 4)
 * contra el mismo server de test.
 */
function smartStubClassifier(): IntentClassifier {
  return {
    classify: vi.fn(async (message: string) => {
      if (message.includes("desastre")) {
        return { intentId: "reclamo_queja", confidence: 0.9 };
      }
      if (message.includes("expensas")) {
        return { intentId: "consulta_precio_condiciones", confidence: 0.9, searchQuery: "Palermo" };
      }
      return { intentId: "consulta_disponibilidad", confidence: 0.92, searchQuery: "Palermo" };
    }),
  };
}

function stubGcal(): GcalQueries {
  return {
    freebusy: vi.fn(),
    createEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
    getEvent: vi.fn(),
    listEvents: vi.fn(),
  };
}

function stubWeather(): WeatherQueries {
  return { getForecast: vi.fn() };
}

/** Stub: reemplaza la redacción final de Claude, pero la mantiene grounded (refleja groundingData). */
function groundedStubComposer(): ResponseComposer {
  return {
    compose: vi.fn(async ({ groundingData }) => `[grounded] ${JSON.stringify(groundingData)}`),
  };
}

function stubDraftComposer(): DraftReplyComposer {
  return { composeDraft: vi.fn(async () => "[borrador] Hola! Dejame confirmarte eso en breve.") };
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

describe("loop end-to-end: webhook -> consulta_disponibilidad -> mcp-tokko real -> audit_log", () => {
  let server: Server;
  let baseUrl: string;
  let tokko: TokkoMcpClient;
  let auditLog: InMemoryAuditLogStore;
  let brokerNotifier: BrokerNotifier & { notifications: BrokerNotification[] };

  beforeAll(async () => {
    const catalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));
    tokko = new TokkoMcpClient({
      entryPath: path.join(repoRoot, "mcp-servers/mcp-tokko/src/index.ts"),
      cwd: path.join(repoRoot, "mcp-servers/mcp-tokko"),
    });
    await tokko.connect();

    auditLog = new InMemoryAuditLogStore();
    brokerNotifier = recordingBrokerNotifier();

    const listener = createRequestListener({
      catalog,
      classifier: smartStubClassifier(),
      composer: groundedStubComposer(),
      draftComposer: stubDraftComposer(),
      auditLog,
      tokko,
      gcal: stubGcal(),
      weather: stubWeather(),
      appointmentStore: new InMemoryAppointmentStore(),
      conversationStateStore: new InMemoryConversationStateStore(),
      slotConfirmationClassifier: { matchSlot: vi.fn(async () => ({ chosenIndex: null })) },
      reprogramActionClassifier: { extractAction: vi.fn(async () => ({ accion: "reprogramar" as const })) },
      globalPauseStore: new InMemoryGlobalPauseStore(),
      pausarAgenteActionClassifier: { extractAction: vi.fn(async () => ({ accion: "pausar" as const, alcance: "global" as const })) },
      defaultLat: -34.6037,
      defaultLng: -58.3816,
      brokerNotifier,
      whatsappWebhookVerifyToken: WEBHOOK_VERIFY_TOKEN,
      whatsappAppSecret: APP_SECRET,
    });

    server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("No se pudo levantar el server de test.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 20000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tokko.close();
  });

  it("responde el handshake GET de verificación de Meta", async () => {
    const res = await fetch(
      `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=${WEBHOOK_VERIFY_TOKEN}&hub.challenge=echo-123`
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo-123");
  });

  it("rechaza un POST con firma inválida", async () => {
    const body = metaTextMessagePayload("5491100000001", "¿el depto de Palermo sigue disponible?");
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=firmaInvalida" },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("procesa el mensaje de prueba de punta a punta y audita el resultado", async () => {
    const body = metaTextMessagePayload("5491100000001", "¿el depto de Palermo sigue disponible?");
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    const entries = await auditLog.readAll();
    const entry = entries.find((e) => e.conversationId === "5491100000001");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      matchedIntentId: "consulta_disponibilidad",
      confidence: 0.92,
      toolsCalled: ["tokko.search_properties", "tokko.get_property"],
      escalatedToBroker: false,
    });
    // La respuesta viene grounded en datos reales devueltos por mcp-tokko
    // (proceso real, MockTokkoClient adentro), no inventados por el stub.
    expect(entry?.responseSent).toContain("disponible");
    expect(entry?.responseSent).toContain("Santa Fe");
  });

  it("Bloque 4: un mensaje que escala responde con el template y notifica al broker con el borrador", async () => {
    const body = metaTextMessagePayload("5491100000003", "esto es un desastre, nadie me atiende");
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      body,
    });

    expect(res.status).toBe(200);

    const entries = await auditLog.readAll();
    const entry = entries.find((e) => e.conversationId === "5491100000003");
    expect(entry).toMatchObject({
      matchedIntentId: "reclamo_queja",
      escalatedToBroker: true,
      escalationRule: "requires_broker",
      toolsCalled: [],
    });

    const notification = brokerNotifier.notifications.find((n) => n.conversationId === "5491100000003");
    expect(notification).toBeDefined();
    expect(notification?.matchedIntentId).toBe("reclamo_queja");
    expect(notification?.draftReply).toContain("borrador");
  });

  it("Bloque 5: consulta_precio_condiciones también corre de punta a punta contra mcp-tokko real", async () => {
    const body = metaTextMessagePayload("5491100000004", "¿cuánto son las expensas del depto de Palermo?");
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      body,
    });

    expect(res.status).toBe(200);

    const entries = await auditLog.readAll();
    const entry = entries.find((e) => e.conversationId === "5491100000004");
    expect(entry).toMatchObject({
      matchedIntentId: "consulta_precio_condiciones",
      escalatedToBroker: false,
      toolsCalled: ["tokko.search_properties", "tokko.get_property"],
    });
    expect(entry?.responseSent).toContain("45000");
  });
});
