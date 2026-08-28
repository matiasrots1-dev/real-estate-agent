// El eco de coexistencia enganchado de punta a punta: llega, se descarta como
// mensaje entrante, y de él sólo se aprovecha "el broker le escribió a esta
// persona en este momento".
//
// El filtro de privacidad es lo que más importa acá: si el destinatario no es
// un contacto del negocio, no queda registro. La vida personal del broker no
// entra al sistema.

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestListener, type AppDeps } from "./app.js";
import { SerialConversationQueue } from "./backgroundQueue.js";
import { LruMessageDeduplicator } from "./messageDedup.js";
import { InMemoryWebhookMetrics } from "./webhookMetrics.js";
import { ContactosConocidos } from "./agent/contactosConocidos.js";
import { InMemoryUltimoContactoStore } from "./agent/ultimoContactoStore.js";
import { InMemoryEstiloBrokerStore } from "./agent/estiloBrokerStore.js";
import { InMemoryAuditLogStore } from "./agent/auditLog.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { InMemoryConversationStateStore } from "./agent/conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./agent/globalPauseStore.js";
import { InMemoryLastInteractionStore } from "./agent/lastInteractionStore.js";
import type { IntentClassification } from "./agent/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog(path.resolve(__dirname, "../../..", "docs/intent_catalog.yaml"));

const APP_SECRET = "test-app-secret";
const firmar = (body: string) => "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");

const CLIENTE = "5491133339999";
const AMIGA = "5491144448888";
const BROKER = "5491155551111";

function ecoHacia(destino: string, timestampSegundos: number, texto = "hola") {
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
                { from: BROKER, to: destino, id: "wamid.eco", timestamp: String(timestampSegundos), type: "text", text: { body: texto } },
              ],
            },
          },
        ],
      },
    ],
  });
}

function mensajeDe(from: string, texto: string, wamid: string) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "111" },
              messages: [{ from, id: wamid, timestamp: "1", type: "text", text: { body: texto } }],
            },
          },
        ],
      },
    ],
  });
}

const abiertos: Server[] = [];

async function levantar(conocidosIniciales: string[] = []) {
  const queue = new SerialConversationQueue({ onError: () => {} });
  const store = new InMemoryUltimoContactoStore();
  const estilo = new InMemoryEstiloBrokerStore();
  const auditLog = new InMemoryAuditLogStore();
  const conocidos = new ContactosConocidos();
  for (const c of conocidosIniciales) conocidos.agregar(c);
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
    backgroundQueue: queue,
    messageDeduplicator: new LruMessageDeduplicator({ onDuplicado: () => {} }),
    webhookMetrics: new InMemoryWebhookMetrics(),
    whatsappAppSecret: APP_SECRET,
    auditLog,
    ultimoContactoStore: store,
    estiloBrokerStore: estilo,
    contactosConocidos: conocidos,
  } as unknown as AppDeps;

  const server = createServer(createRequestListener(deps));
  abiertos.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no levantó");
  return { baseUrl: `http://127.0.0.1:${address.port}`, queue, store, estilo, auditLog, conocidos, procesados };
}

function postear(baseUrl: string, body: string): Promise<Response> {
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

describe("el eco registra que el broker contactó a mano", () => {
  it("registra el contacto cuando el destinatario ya escribió antes", async () => {
    const { baseUrl, queue, store } = await levantar([CLIENTE]);

    await postear(baseUrl, ecoHacia(CLIENTE, 1756000000));
    await queue.idle();

    const registro = await store.get(CLIENTE);
    expect(registro?.origen).toBe("manual");
    expect(registro?.contactadoAt).toBe(new Date(1756000000 * 1000).toISOString());
  });

  // EL filtro de privacidad. Si el broker le escribe a su familia desde el
  // mismo celular, eso NO puede quedar en el sistema de la inmobiliaria.
  it("NO registra nada si el destinatario nunca escribió al agente", async () => {
    const { baseUrl, queue, store } = await levantar([CLIENTE]);

    await postear(baseUrl, ecoHacia(AMIGA, 1756000000, "nos vemos el domingo"));
    await queue.idle();

    expect(await store.get(AMIGA)).toBeNull();
    expect(await store.all()).toHaveLength(0);
  });

  it("alguien pasa a ser conocido en cuanto escribe", async () => {
    const { baseUrl, queue, store } = await levantar([]);

    // Primero el eco: todavía no lo conocemos, no se registra.
    await postear(baseUrl, ecoHacia(CLIENTE, 1756000000));
    await queue.idle();
    expect(await store.get(CLIENTE)).toBeNull();

    // El cliente escribe: ahora sí es un contacto del negocio.
    await postear(baseUrl, mensajeDe(CLIENTE, "hola, consulta", "wamid.1"));
    await queue.idle();

    // Un eco posterior sí queda registrado.
    await postear(baseUrl, ecoHacia(CLIENTE, 1756000500));
    await queue.idle();
    expect(await store.get(CLIENTE)).not.toBeNull();
  });

  it("el eco sigue SIN procesarse como mensaje entrante", async () => {
    const { baseUrl, queue, procesados } = await levantar([CLIENTE]);

    await postear(baseUrl, ecoHacia(CLIENTE, 1756000000, "esto es del broker"));
    await queue.idle();

    // El canal broker no se toca: el eco no llega al clasificador.
    expect(procesados).toEqual([]);
  });

  it("no guarda el texto del mensaje, sólo a quién y cuándo", async () => {
    const { baseUrl, queue, store } = await levantar([CLIENTE]);

    await postear(baseUrl, ecoHacia(CLIENTE, 1756000000, "algo privado que dijo el broker"));
    await queue.idle();

    expect(JSON.stringify(await store.all())).not.toContain("algo privado");
  });

  it("varios destinatarios en un eco se filtran uno por uno", async () => {
    const { baseUrl, queue, store } = await levantar([CLIENTE]);
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                message_echoes: [
                  { to: CLIENTE, timestamp: "1756000000", type: "text" },
                  { to: AMIGA, timestamp: "1756000000", type: "text" },
                ],
              },
            },
          ],
        },
      ],
    });

    await postear(baseUrl, body);
    await queue.idle();

    expect(await store.get(CLIENTE)).not.toBeNull();
    expect(await store.get(AMIGA)).toBeNull();
  });

  it("el eco responde 200 igual, registre o no", async () => {
    const { baseUrl, queue } = await levantar([]);

    const res = await postear(baseUrl, ecoHacia(AMIGA, 1756000000));
    await queue.idle();

    expect(res.status).toBe(200);
  });
});

describe("corpus de estilo del broker", () => {
  const CLIENTE2 = "5491166667777";

  /**
   * Siembra una entrada del audit log directamente. Pasar un mensaje por el
   * webhook obligaria a stubbear el agente entero, y lo que se prueba aca es
   * el corpus, no la clasificacion.
   */
  async function clienteEscribio(
    auditLog: InMemoryAuditLogStore,
    de: string,
    intent: string,
    cuando: string
  ): Promise<void> {
    await auditLog.append({
      id: `audit-${cuando}`,
      conversationId: de,
      timestamp: cuando,
      incomingMessage: "lo que sea que pregunto",
      matchedIntentId: intent,
      confidence: 0.9,
      toolsCalled: [],
      escalatedToBroker: false,
    });
  }

  /** 2030-03-17T10:26:40Z, la fecha del timestamp 1900000000 usado en los ecos. */
  const ANTES_DEL_ECO = "2030-03-17T09:00:00.000Z";

  it("guarda lo que escribe el broker, con el intent al que respondia", async () => {
    const { baseUrl, queue, estilo, auditLog } = await levantar([CLIENTE]);
    await clienteEscribio(auditLog, CLIENTE, "agendar_visita", ANTES_DEL_ECO);

    await postear(baseUrl, ecoHacia(CLIENTE, 1900000000, "Dale, te espero el jueves a las 10 sin falta"));
    await queue.idle();

    const ejemplos = await estilo.all();
    expect(ejemplos).toHaveLength(1);
    expect(ejemplos[0]?.intent).toBe("agendar_visita");
    expect(ejemplos[0]?.texto).toContain("te espero el jueves");
  });

  // EL punto del pedido: que aprenda el TONO, no los datos de un cliente.
  it("guarda el texto ANONIMIZADO, nunca el original", async () => {
    const { baseUrl, queue, estilo, auditLog } = await levantar([CLIENTE]);
    await clienteEscribio(auditLog, CLIENTE, "agendar_visita", ANTES_DEL_ECO);

    await postear(
      baseUrl,
      ecoHacia(CLIENTE, 1900000000, "Hola Fernando! Te confirmo Olleros 3700, escribime al 11 5555-9999")
    );
    await queue.idle();

    const [ejemplo] = await estilo.all();
    expect(ejemplo?.texto).not.toContain("Fernando");
    expect(ejemplo?.texto).not.toContain("Olleros");
    expect(ejemplo?.texto).not.toContain("5555");
    // Pero el tono queda: la forma de confirmar sigue ahi.
    expect(ejemplo?.texto).toContain("Te confirmo");
  });

  it("no guarda nada de alguien que no es contacto conocido", async () => {
    const { baseUrl, queue, estilo, auditLog } = await levantar([CLIENTE]);
    await clienteEscribio(auditLog, CLIENTE, "agendar_visita", ANTES_DEL_ECO);

    await postear(baseUrl, ecoHacia(AMIGA, 1900000000, "Nos vemos el domingo en casa de mama"));
    await queue.idle();

    expect(await estilo.all()).toHaveLength(0);
  });

  // Sin un mensaje previo del cliente no hay intent, y un ejemplo sin contexto
  // no se puede elegir despues.
  it("no guarda si el broker inicio la conversacion", async () => {
    const { baseUrl, queue, estilo } = await levantar([CLIENTE2]);

    await postear(baseUrl, ecoHacia(CLIENTE2, 1900000000, "Hola, te paso la info que me pediste ayer"));
    await queue.idle();

    expect(await estilo.all()).toHaveLength(0);
  });

  it("descarta mensajes demasiado cortos para ensenar algo", async () => {
    const { baseUrl, queue, estilo, auditLog } = await levantar([CLIENTE]);
    await clienteEscribio(auditLog, CLIENTE, "agendar_visita", ANTES_DEL_ECO);

    await postear(baseUrl, ecoHacia(CLIENTE, 1900000000, "ok"));
    await queue.idle();

    expect(await estilo.all()).toHaveLength(0);
  });

  it("el corpus no guarda a quien le escribio", async () => {
    const { baseUrl, queue, estilo, auditLog } = await levantar([CLIENTE]);
    await clienteEscribio(auditLog, CLIENTE, "agendar_visita", ANTES_DEL_ECO);

    await postear(baseUrl, ecoHacia(CLIENTE, 1900000000, "Perfecto, lo coordinamos para esta semana entonces"));
    await queue.idle();

    // Sin destinatario, un ejemplo no se puede volver a atar a una persona.
    expect(JSON.stringify(await estilo.all())).not.toContain(CLIENTE);
  });

  it("un intent posterior al eco no cuenta: se busca el ANTERIOR", async () => {
    const { baseUrl, queue, estilo, auditLog } = await levantar([CLIENTE]);
    await clienteEscribio(auditLog, CLIENTE, "agendar_visita", ANTES_DEL_ECO);
    await clienteEscribio(auditLog, CLIENTE, "reclamo_queja", "2030-03-18T10:00:00.000Z");

    await postear(baseUrl, ecoHacia(CLIENTE, 1900000000, "Perfecto, lo coordinamos para esta semana entonces"));
    await queue.idle();

    expect((await estilo.all())[0]?.intent).toBe("agendar_visita");
  });
});
