// Dos cosas confirmadas por el proveedor sobre payloads reales:
//  - el espejo de coexistencia llega con field "smb_message_echoes" y el array
//    en value.message_echoes, sin value.messages;
//  - van a autenticar sus reenvíos con el header X-DoubleTick-Secret.

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestListener, type AppDeps } from "./app.js";
import { authorizeWebhookRequest } from "./channels/whatsapp/signature.js";
import { esEcoDeCoexistencia } from "./channels/whatsapp/webhookPayload.js";
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
const SECRETO_PROVEEDOR = "secreto-compartido-con-el-proveedor";
const BROKER = "5491155551111";

function firmar(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

/** Forma real del espejo, según el proveedor. */
function ecoPayload(): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              metadata: { phone_number_id: "111" },
              message_echoes: [
                { from: BROKER, to: "5491133339999", id: "wamid.eco", type: "text", text: { body: "te paso el precio" } },
              ],
            },
          },
        ],
      },
    ],
  });
}

function mensajeCliente(texto: string, wamid: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "111" },
              messages: [{ from: "5491133339999", id: wamid, timestamp: "1", type: "text", text: { body: texto } }],
            },
          },
        ],
      },
    ],
  });
}

/** Meta agrupa `changes`: un eco y un mensaje real en el mismo POST. */
function ecoYMensajeJuntos(texto: string, wamid: string): string {
  const eco = JSON.parse(ecoPayload());
  const real = JSON.parse(mensajeCliente(texto, wamid));
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [...eco.entry[0].changes, ...real.entry[0].changes] }],
  });
}

const abiertos: Server[] = [];

async function levantar(overrides: Partial<AppDeps> = {}) {
  const queue = new SerialConversationQueue({ onError: () => {} });
  const metrics = new InMemoryWebhookMetrics();
  const procesados: string[] = [];

  const deps = {
    catalog,
    conversationStateStore: new InMemoryConversationStateStore(),
    globalPauseStore: new InMemoryGlobalPauseStore(),
    lastInteractionStore: new InMemoryLastInteractionStore(),
    classifier: {
      async classify(texto: string): Promise<IntentClassification> {
        procesados.push(texto);
        return { intentId: "no_existe", confidence: 1 };
      },
    },
    whatsappAppSecret: APP_SECRET,
    brokerWhatsappNumber: BROKER,
    backgroundQueue: queue,
    messageDeduplicator: new LruMessageDeduplicator({ onDuplicado: () => {} }),
    webhookMetrics: metrics,
    ...overrides,
  } as unknown as AppDeps;

  const server = createServer(createRequestListener(deps));
  abiertos.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no levantó");
  return { baseUrl: `http://127.0.0.1:${address.port}`, queue, metrics, procesados };
}

function postear(baseUrl: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

afterEach(async () => {
  await Promise.all(
    abiertos.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe("espejo de coexistencia", () => {
  it("reconoce el payload real del eco", () => {
    expect(esEcoDeCoexistencia(JSON.parse(ecoPayload()))).toBe(true);
  });

  it("un mensaje normal de cliente no es un eco", () => {
    expect(esEcoDeCoexistencia(JSON.parse(mensajeCliente("hola", "wamid.1")))).toBe(false);
  });

  it("se descarta con su categoría propia, sin llegar al agente", async () => {
    const { baseUrl, queue, metrics, procesados } = await levantar();

    const res = await postear(baseUrl, ecoPayload(), { "X-Hub-Signature-256": firmar(ecoPayload()) });
    await queue.idle();

    expect(res.status).toBe(200);
    expect(procesados).toEqual([]);
    expect(metrics.resumen().porResultado).toEqual({ eco_descartado: 1 });
  });

  // Modo de fallo 1 del pre-mortem: Meta agrupa changes, así que un eco puede
  // viajar junto a un mensaje legítimo. Perder mensajes de clientes sería peor
  // que procesar un eco de más.
  it("NO descarta un mensaje real que viene en el mismo POST que un eco", async () => {
    const { baseUrl, queue, metrics, procesados } = await levantar();
    const body = ecoYMensajeJuntos("¿sigue disponible?", "wamid.mixto");

    await postear(baseUrl, body, { "X-Hub-Signature-256": firmar(body) });
    await queue.idle();

    expect(procesados).toEqual(["¿sigue disponible?"]);
    expect(metrics.resumen().porResultado).toEqual({ procesado: 1 });
  });

  it("y el detector lo dice también a nivel función pura", () => {
    expect(esEcoDeCoexistencia(JSON.parse(ecoYMensajeJuntos("hola", "wamid.x")))).toBe(false);
  });
});

describe("autenticación por header del proveedor", () => {
  describe("función pura", () => {
    const body = Buffer.from("{}");

    it("acepta el header correcto", () => {
      expect(
        authorizeWebhookRequest({
          rawBody: body,
          signatureHeader: undefined,
          appSecret: APP_SECRET,
          providerSecret: SECRETO_PROVEEDOR,
          providerSecretHeader: SECRETO_PROVEEDOR,
        })
      ).toEqual({ aceptado: true, motivo: "secreto_proveedor_valido" });
    });

    it("rechaza el header incorrecto con motivo propio", () => {
      expect(
        authorizeWebhookRequest({
          rawBody: body,
          signatureHeader: undefined,
          appSecret: APP_SECRET,
          providerSecret: SECRETO_PROVEEDOR,
          providerSecretHeader: "adivinado",
        })
      ).toEqual({ aceptado: false, motivo: "secreto_proveedor_invalido" });
    });

    // Modo de fallo 2 del pre-mortem: un secreto vacío que acepta cualquier
    // cosa es la misma trampa que el App Secret vacío.
    it.each(["", "   ", undefined])(
      "con el secreto configurado como %o el header se ignora por completo",
      (secreto) => {
        const r = authorizeWebhookRequest({
          rawBody: body,
          signatureHeader: undefined,
          appSecret: APP_SECRET,
          providerSecret: secreto,
          providerSecretHeader: "",
        });
        // Cae al camino HMAC y rechaza por falta de firma, no acepta.
        expect(r).toEqual({ aceptado: false, motivo: "firma_ausente" });
      }
    );
  });

  // Modo de fallo 3 del pre-mortem: configurar el secreto del proveedor no
  // puede romper la entrega directa de Meta, que no trae ese header.
  describe("convivencia con la HMAC de Meta", () => {
    it("el reenvío del proveedor entra por el header, sin firma", async () => {
      const { baseUrl, queue, procesados } = await levantar({
        webhookProviderSecret: SECRETO_PROVEEDOR,
      });

      const res = await postear(baseUrl, mensajeCliente("desde el proveedor", "wamid.p"), {
        "X-DoubleTick-Secret": SECRETO_PROVEEDOR,
      });
      await queue.idle();

      expect(res.status).toBe(200);
      expect(procesados).toEqual(["desde el proveedor"]);
    });

    it("Meta directo sigue entrando por la firma, con el mismo .env", async () => {
      const { baseUrl, queue, procesados } = await levantar({
        webhookProviderSecret: SECRETO_PROVEEDOR,
      });
      const body = mensajeCliente("directo de Meta", "wamid.m");

      const res = await postear(baseUrl, body, { "X-Hub-Signature-256": firmar(body) });
      await queue.idle();

      expect(res.status).toBe(200);
      expect(procesados).toEqual(["directo de Meta"]);
    });

    it("un header inventado se rechaza y queda contado aparte", async () => {
      const { baseUrl, metrics } = await levantar({ webhookProviderSecret: SECRETO_PROVEEDOR });

      const res = await postear(baseUrl, mensajeCliente("intruso", "wamid.i"), {
        "X-DoubleTick-Secret": "me-lo-invente",
      });

      expect(res.status).toBe(401);
      expect(metrics.resumen().porResultado).toEqual({ rechazado_secreto_proveedor: 1 });
    });

    // Contrato con el proveedor: el nombre del header es case-insensitive
    // porque Node normaliza los headers entrantes a minúsculas. Se fija con un
    // test para no tener que confirmarlo en producción — perder una ventana de
    // prueba por una mayúscula sería un costo absurdo.
    it.each([
      "X-DoubleTick-Secret",
      "x-doubletick-secret",
      "X-DOUBLETICK-SECRET",
      "X-doubletick-Secret",
    ])("acepta el header escrito como %s", async (nombreHeader) => {
      const { baseUrl, queue, procesados } = await levantar({
        webhookProviderSecret: SECRETO_PROVEEDOR,
      });

      const res = await postear(baseUrl, mensajeCliente(nombreHeader, `wamid.${nombreHeader}`), {
        [nombreHeader]: SECRETO_PROVEEDOR,
      });
      await queue.idle();

      expect(res.status).toBe(200);
      expect(procesados).toEqual([nombreHeader]);
    });

    // Los guiones sí importan: no hay normalización que los arregle.
    it.each(["XDoubleTickSecret", "X_DoubleTick_Secret", "DoubleTick-Secret"])(
      "NO reconoce %s (los guiones y el prefijo sí importan)",
      async (nombreHeader) => {
        const { baseUrl } = await levantar({ webhookProviderSecret: SECRETO_PROVEEDOR });

        const res = await postear(baseUrl, mensajeCliente("x", "wamid.y"), {
          [nombreHeader]: SECRETO_PROVEEDOR,
        });

        expect(res.status).toBe(401);
      }
    );

    it("sin header y sin firma sigue rechazando", async () => {
      const { baseUrl } = await levantar({ webhookProviderSecret: SECRETO_PROVEEDOR });

      expect((await postear(baseUrl, mensajeCliente("x", "wamid.x"), {})).status).toBe(401);
    });
  });
});
