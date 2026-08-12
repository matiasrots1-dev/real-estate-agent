// La deduplicación a través del webhook real, no sólo en la clase suelta: el
// modo de fallo que importa es "el filtro funciona pero app.ts no lo llama, o
// lo llama en el lugar equivocado", y un test de la clase aislada pasa verde
// en los tres casos.
//
// Escenario que se está reproduciendo: el proveedor no reintenta, pero su
// forward está enganchado antes de su CRM. Si el CRM devuelve un no-200, Meta
// reintenta el POST y el forward se dispara otra vez con el MISMO wamid.

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestListener, type AppDeps } from "./app.js";
import { SerialConversationQueue } from "./backgroundQueue.js";
import { LruMessageDeduplicator } from "./messageDedup.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { InMemoryConversationStateStore } from "./agent/conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./agent/globalPauseStore.js";
import { InMemoryLastInteractionStore } from "./agent/lastInteractionStore.js";
import type { IntentClassification } from "./agent/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog(path.resolve(__dirname, "../../..", "docs/intent_catalog.yaml"));

// Firmados como los manda Meta: sin App Secret el webhook rechaza todo, y
// estos tests fallarían por una razón que no tiene que ver con la dedup.
const APP_SECRET = "test-app-secret";
function firmar(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function payload(from: string, text: string, wamid: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "111222333" },
              messages: [
                { from, id: wamid, timestamp: "1", type: "text", text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });
}

const abiertos: Server[] = [];

interface Banco {
  baseUrl: string;
  queue: SerialConversationQueue;
  dedup: LruMessageDeduplicator;
  /** Un elemento por mensaje efectivamente procesado. */
  procesados: string[];
}

async function levantar(capacidad?: number): Promise<Banco> {
  const queue = new SerialConversationQueue({ onError: () => {} });
  const dedup = new LruMessageDeduplicator({
    capacidad,
    onDuplicado: () => {},
    onDesalojo: () => {},
  });
  const procesados: string[] = [];

  const deps = {
    catalog,
    conversationStateStore: new InMemoryConversationStateStore(),
    globalPauseStore: new InMemoryGlobalPauseStore(),
    lastInteractionStore: new InMemoryLastInteractionStore(),
    classifier: {
      async classify(texto: string): Promise<IntentClassification> {
        procesados.push(texto);
        return { intentId: "no_existe_en_el_catalogo", confidence: 1 };
      },
    },
    whatsappAppSecret: APP_SECRET,
    backgroundQueue: queue,
    messageDeduplicator: dedup,
  } as unknown as AppDeps;

  const server = createServer(createRequestListener(deps));
  abiertos.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No levantó el server.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, queue, dedup, procesados };
}

function postear(baseUrl: string, from: string, texto: string, wamid: string): Promise<Response> {
  const body = payload(from, texto, wamid);
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": firmar(body) },
    body,
  });
}

afterEach(async () => {
  await Promise.all(
    abiertos.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe("deduplicación por message id, a través del webhook", () => {
  it("el reintento de Meta con el mismo wamid se procesa una sola vez", async () => {
    const { baseUrl, queue, dedup, procesados } = await levantar();

    await postear(baseUrl, "5491111111111", "hola", "wamid.MISMO");
    await postear(baseUrl, "5491111111111", "hola", "wamid.MISMO");
    await postear(baseUrl, "5491111111111", "hola", "wamid.MISMO");
    await queue.idle();

    expect(procesados).toEqual(["hola"]);
    expect(dedup.duplicadosDescartados()).toBe(2);
  });

  it("al duplicado también se le contesta 200", async () => {
    const { baseUrl, queue } = await levantar();

    await postear(baseUrl, "5491111111111", "hola", "wamid.MISMO");
    const repetido = await postear(baseUrl, "5491111111111", "hola", "wamid.MISMO");
    await queue.idle();

    // Un no-200 haría que Meta reintente todavía más: exactamente al revés de
    // lo que se busca.
    expect(repetido.status).toBe(200);
    expect(await repetido.json()).toEqual({ received: true });
  });

  it("mensajes distintos del mismo cliente se procesan todos", async () => {
    const { baseUrl, queue, dedup, procesados } = await levantar();

    await postear(baseUrl, "5491111111111", "hola", "wamid.1");
    await postear(baseUrl, "5491111111111", "¿sigue disponible?", "wamid.2");
    await postear(baseUrl, "5491111111111", "gracias", "wamid.3");
    await queue.idle();

    expect(procesados).toEqual(["hola", "¿sigue disponible?", "gracias"]);
    expect(dedup.duplicadosDescartados()).toBe(0);
  });

  // El caso real: los reintentos de Meta pueden solaparse. Si el filtro no
  // fuera indivisible, dos POSTs simultáneos pasarían los dos.
  it("varios reintentos simultáneos del mismo wamid dejan pasar uno solo", async () => {
    const { baseUrl, queue, procesados } = await levantar();

    await Promise.all(
      Array.from({ length: 8 }, () => postear(baseUrl, "5491111111111", "hola", "wamid.STORM"))
    );
    await queue.idle();

    expect(procesados).toEqual(["hola"]);
  });

  it("dos clientes distintos con el mismo texto no se pisan", async () => {
    const { baseUrl, queue, procesados } = await levantar();

    await postear(baseUrl, "5491111111111", "hola", "wamid.A");
    await postear(baseUrl, "5492222222222", "hola", "wamid.B");
    await queue.idle();

    expect(procesados).toEqual(["hola", "hola"]);
  });

  it("un mensaje sin id utilizable se procesa igual, no se descarta", async () => {
    const { baseUrl, queue, procesados } = await levantar();

    // Dos mensajes reales distintos que llegan con el id en blanco: el peor
    // error posible sería tragarse el segundo.
    await postear(baseUrl, "5491111111111", "primero", "");
    await postear(baseUrl, "5491111111111", "segundo", "");
    await queue.idle();

    expect(procesados).toEqual(["primero", "segundo"]);
  });
});
