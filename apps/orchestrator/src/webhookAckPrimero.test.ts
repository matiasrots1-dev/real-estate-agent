// El webhook responde 200 antes de procesar, y el procesamiento queda
// encolado por conversación. Probado a nivel HTTP real, no sólo en la cola
// suelta: el modo de fallo que importa es "la cola funciona pero app.ts no la
// usa", y un test de la cola aislada pasa verde en ese caso.
//
// El punto de control es el classifier: es el primer await caro de
// handleIncomingMessage, así que bloquearlo bloquea la tarea entera. Que
// después la tarea falle no molesta — lo que se observa es el ORDEN en que
// arrancan, y la cola contiene el error.

import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestListener, type AppDeps } from "./app.js";
import { SerialConversationQueue } from "./backgroundQueue.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { InMemoryConversationStateStore } from "./agent/conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./agent/globalPauseStore.js";
import { InMemoryLastInteractionStore } from "./agent/lastInteractionStore.js";
import type { IntentClassification } from "./agent/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog(path.resolve(__dirname, "../../..", "docs/intent_catalog.yaml"));

function payload(from: string, text: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "111222333" },
              messages: [
                { from, id: `wamid.${text}`, timestamp: "1", type: "text", text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });
}

function diferida() {
  let resolver!: () => void;
  const promesa = new Promise<void>((res) => {
    resolver = res;
  });
  return { promesa, resolver };
}

const abiertos: Server[] = [];

interface Banco {
  baseUrl: string;
  queue: SerialConversationQueue;
  /** Texto de cada mensaje, en el orden en que empezó a clasificarse. */
  arrancaron: string[];
}

/**
 * Levanta el listener real con un classifier que el test controla.
 * `alClasificar` recibe el texto y devuelve la promesa que la tarea va a
 * esperar; lo que pase después no importa para estos tests.
 */
async function levantar(
  alClasificar: (texto: string) => Promise<unknown> = async () => {}
): Promise<Banco> {
  const queue = new SerialConversationQueue({ onError: () => {} });
  const arrancaron: string[] = [];

  const deps = {
    catalog,
    conversationStateStore: new InMemoryConversationStateStore(),
    globalPauseStore: new InMemoryGlobalPauseStore(),
    lastInteractionStore: new InMemoryLastInteractionStore(),
    classifier: {
      async classify(texto: string): Promise<IntentClassification> {
        arrancaron.push(texto);
        await alClasificar(texto);
        // Un intent inexistente corta el flujo sin necesitar tools ni composer.
        return { intentId: "no_existe_en_el_catalogo", confidence: 1 };
      },
    },
    whatsappAppSecret: undefined,
    backgroundQueue: queue,
  } as unknown as AppDeps;

  const server = createServer(createRequestListener(deps));
  abiertos.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No levantó el server.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, queue, arrancaron };
}

function postear(baseUrl: string, from: string, texto: string): Promise<Response> {
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload(from, texto),
  });
}

afterEach(async () => {
  await Promise.all(
    abiertos.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe("/webhook responde antes de procesar", () => {
  it("devuelve 200 con el procesamiento todavía en curso", async () => {
    const bloqueo = diferida();
    const { baseUrl, queue } = await levantar(() => bloqueo.promesa);

    const res = await postear(baseUrl, "5491111111111", "hola");

    // El 200 ya volvió y el trabajo sigue pendiente: eso es exactamente lo que
    // el proveedor necesita para no cortarnos a los 3 segundos.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(queue.pending()).toBe(1);

    bloqueo.resolver();
    await queue.idle();
    expect(queue.pending()).toBe(0);
  });

  it("un payload sin mensajes no encola nada", async () => {
    const { baseUrl, queue } = await levantar();
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
    });

    expect(res.status).toBe(200);
    expect(queue.pending()).toBe(0);
  });

  it("el JSON inválido sigue devolviendo 400 y no encola", async () => {
    const { baseUrl, queue } = await levantar();
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ esto no es json",
    });

    expect(res.status).toBe(400);
    expect(queue.pending()).toBe(0);
  });
});

describe("serialización por conversación, a través del webhook", () => {
  it("dos mensajes del mismo teléfono no se procesan en paralelo", async () => {
    const bloqueo = diferida();
    let primero = true;
    const { baseUrl, queue, arrancaron } = await levantar(() => {
      if (primero) {
        primero = false;
        return bloqueo.promesa;
      }
      return Promise.resolve();
    });

    await postear(baseUrl, "5491111111111", "primero");
    await postear(baseUrl, "5491111111111", "segundo");

    // El segundo llegó y ya fue respondido con 200, pero todavía no arrancó:
    // está esperando a que termine el primero.
    expect(arrancaron).toEqual(["primero"]);
    expect(queue.pending()).toBe(2);

    bloqueo.resolver();
    await queue.idle();
    expect(arrancaron).toEqual(["primero", "segundo"]);
  });

  it("un teléfono lento no bloquea a los demás", async () => {
    const bloqueo = diferida();
    const { baseUrl, queue, arrancaron } = await levantar((texto) =>
      texto === "lento" ? bloqueo.promesa : Promise.resolve()
    );

    await postear(baseUrl, "5491111111111", "lento");
    await postear(baseUrl, "5492222222222", "de otro cliente");
    await postear(baseUrl, "5493333333333", "de un tercero");

    // Conversaciones distintas: no tienen por qué esperar al primero.
    await new Promise((r) => setImmediate(r));
    expect(arrancaron).toContain("de otro cliente");
    expect(arrancaron).toContain("de un tercero");

    bloqueo.resolver();
    await queue.idle();
  });
});

describe("contención de errores del procesamiento", () => {
  it("un mensaje que explota no tumba el proceso ni la respuesta HTTP", async () => {
    const { baseUrl, queue } = await levantar(() => {
      throw new Error("el handler explotó");
    });

    const res = await postear(baseUrl, "5491111111111", "mensaje raro");

    expect(res.status).toBe(200);
    await expect(queue.idle()).resolves.toBeUndefined();
  });

  it("después de un mensaje que explota, el siguiente del mismo cliente se atiende igual", async () => {
    const { baseUrl, queue, arrancaron } = await levantar((texto) => {
      if (texto === "explota") throw new Error("boom");
      return Promise.resolve();
    });

    await postear(baseUrl, "5491111111111", "explota");
    await postear(baseUrl, "5491111111111", "y este tiene que salir igual");
    await queue.idle();

    expect(arrancaron).toEqual(["explota", "y este tiene que salir igual"]);
  });
});
