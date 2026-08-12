// Reconstrucción del incidente del 2026-08-12 en miniatura: el proveedor midió
// 39 POST y el audit_log tenía 6, y no había forma de explicar los otros 33.
// Estos tests fijan que ahora sí la hay.

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestListener, type AppDeps } from "./app.js";
import { SerialConversationQueue } from "./backgroundQueue.js";
import { LruMessageDeduplicator } from "./messageDedup.js";
import { InMemoryWebhookMetrics } from "./webhookMetrics.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { InMemoryConversationStateStore } from "./agent/conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./agent/globalPauseStore.js";
import { InMemoryLastInteractionStore } from "./agent/lastInteractionStore.js";
import type { IntentClassification } from "./agent/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog(path.resolve(__dirname, "../../..", "docs/intent_catalog.yaml"));
const APP_SECRET = "test-app-secret";

function firmar(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function mensajeTexto(from: string, wamid: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "111" },
              messages: [{ from, id: wamid, timestamp: "1", type: "text", text: { body: "hola" } }],
            },
          },
        ],
      },
    ],
  });
}

/** Lo que Meta manda por cada cambio de estado de un saliente. */
function statusWebhook(estado: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "111" },
              statuses: [{ id: "wamid.saliente", status: estado, recipient_id: "549111" }],
            },
          },
        ],
      },
    ],
  });
}

function mensajeNoTexto(tipo: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "111" },
              messages: [{ from: "549111", id: "wamid.img", timestamp: "1", type: tipo }],
            },
          },
        ],
      },
    ],
  });
}

const abiertos: Server[] = [];

async function levantar() {
  const queue = new SerialConversationQueue({ onError: () => {} });
  const metrics = new InMemoryWebhookMetrics(new Date("2026-08-12T13:00:00Z"));
  const deps = {
    catalog,
    conversationStateStore: new InMemoryConversationStateStore(),
    globalPauseStore: new InMemoryGlobalPauseStore(),
    lastInteractionStore: new InMemoryLastInteractionStore(),
    classifier: {
      async classify(): Promise<IntentClassification> {
        return { intentId: "no_existe", confidence: 1 };
      },
    },
    whatsappAppSecret: APP_SECRET,
    backgroundQueue: queue,
    messageDeduplicator: new LruMessageDeduplicator({ onDuplicado: () => {} }),
    webhookMetrics: metrics,
  } as unknown as AppDeps;

  const server = createServer(createRequestListener(deps));
  abiertos.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no levantó");
  return { baseUrl: `http://127.0.0.1:${address.port}`, queue, metrics };
}

function postear(baseUrl: string, body: string, firma = firmar(body)): Promise<Response> {
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": firma },
    body,
  });
}

afterEach(async () => {
  await Promise.all(
    abiertos.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe("el sistema puede explicar qué pasó con cada POST", () => {
  it("los totales cierran: cada POST cae en exactamente una categoría", async () => {
    const { baseUrl, queue, metrics } = await levantar();

    await postear(baseUrl, mensajeTexto("549111", "wamid.1"));
    await postear(baseUrl, mensajeTexto("549111", "wamid.1")); // duplicado
    await postear(baseUrl, statusWebhook("sent"));
    await postear(baseUrl, statusWebhook("delivered"));
    await postear(baseUrl, statusWebhook("read"));
    await postear(baseUrl, mensajeNoTexto("image"));
    // Firmado bien pero no es JSON. Tiene que ir firmado: la firma se valida
    // sobre los bytes crudos, así que un body roto SIN firma se rechaza antes
    // de llegar al parse y contaría como rechazo de firma, no como json_invalido.
    await postear(baseUrl, "{ roto");
    await postear(baseUrl, mensajeTexto("549222", "wamid.2"), "sha256=firmaMala");
    await queue.idle();

    const r = metrics.resumen();
    expect(r.total).toBe(8);
    expect(r.porResultado).toEqual({
      procesado: 1,
      duplicado: 1,
      sin_mensaje: 4,
      json_invalido: 1,
      rechazado_firma_invalida: 1,
    });
    // La suma de las partes es el total: no hay POSTs sin clasificar.
    expect(Object.values(r.porResultado).reduce((a, b) => a + b, 0)).toBe(r.total);
  });

  // Es la distinción que hacía falta el 2026-08-12: "me llegaron 30 statuses"
  // y "me llegaron 30 mensajes de un tipo que no soporto" son problemas
  // opuestos y antes los dos eran el mismo silencio.
  it("desglosa los sin_mensaje por tipo de payload", async () => {
    const { baseUrl, metrics } = await levantar();

    await postear(baseUrl, statusWebhook("sent"));
    await postear(baseUrl, statusWebhook("delivered"));
    await postear(baseUrl, mensajeNoTexto("image"));
    await postear(baseUrl, mensajeNoTexto("audio"));

    expect(metrics.resumen().sinMensajePorTipo).toEqual({
      status: 2,
      "mensaje_tipo:image": 1,
      "mensaje_tipo:audio": 1,
    });
  });

  it("GET /health devuelve el resumen sin tener que mirar la consola", async () => {
    const { baseUrl } = await levantar();
    await postear(baseUrl, statusWebhook("sent"));

    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as { ok: boolean; webhook: { total: number; desde: string } };

    expect(body.ok).toBe(true);
    expect(body.webhook.total).toBe(1);
    // Modo de fallo 3 del pre-mortem: sin "desde", un reinicio hace leer la
    // ventana equivocada y se saca la conclusión de otro rato.
    expect(body.webhook.desde).toBe("2026-08-12T13:00:00.000Z");
  });

  describe("las dos salidas que antes eran mudas ahora logean", () => {
    it("el JSON inválido deja una línea", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { baseUrl } = await levantar();

      await postear(baseUrl, "{ roto");

      expect(warn.mock.calls.flat().join(" ")).toContain("json_invalido");
      warn.mockRestore();
    });

    it("un payload sin mensaje deja una línea con el tipo", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { baseUrl } = await levantar();

      await postear(baseUrl, statusWebhook("delivered"));

      expect(log.mock.calls.flat().join(" ")).toContain("tipo=status");
      log.mockRestore();
    });
  });

  // El log de descartes no puede convertirse en un almacén de datos personales
  // fuera de la política de retención (modo de fallo 1 del pre-mortem).
  it("nunca loguea el contenido ni el teléfono", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { baseUrl } = await levantar();

    await postear(baseUrl, mensajeNoTexto("image"));
    await postear(baseUrl, statusWebhook("read"));

    const todo = [...log.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(todo).not.toContain("549111");
    expect(todo).not.toContain("hola");
    log.mockRestore();
    warn.mockRestore();
  });
});
