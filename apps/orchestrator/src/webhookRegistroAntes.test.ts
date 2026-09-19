// Bloque 34: el audit log se escribe SIEMPRE, antes de clasificar.
//
// Pasó de verdad el 2026-08-28: se acabó el crédito de la API de Anthropic y
// los mensajes se evaporaron. Se prueba a través del webhook real y no con las
// funciones sueltas, porque el modo de fallo que importa es "la función existe
// pero app.ts no la llama, o la llama en el lugar equivocado", y un test de la
// función aislada pasa verde en los dos casos.

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditLogEntry } from "shared-types";
import { createRequestListener, type AppDeps } from "./app.js";
import { SerialConversationQueue } from "./backgroundQueue.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { InMemoryAuditLogStore } from "./agent/auditLog.js";
import { InMemoryConversationStateStore } from "./agent/conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./agent/globalPauseStore.js";
import { InMemoryLastInteractionStore } from "./agent/lastInteractionStore.js";
import { AvisoDeFallos } from "./agent/avisoDeFallos.js";
import { colapsarPorMensaje } from "./agent/auditPorMensaje.js";
import type { ContextoConversacion, IntentClassification } from "./agent/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog(path.resolve(__dirname, "../../..", "docs/intent_catalog.yaml"));

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
              messages: [{ from, id: wamid, timestamp: "1", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

const TELEFONO = "5491155550000";

/** Lo que devuelve el clasificador cuando anda: un fallback, que escala con plantilla y no necesita tools. */
const ANDA: IntentClassification = { intentId: "fallback_low_confidence", confidence: 0.1 };

/** El error real del 2026-08-28. */
function sinCredito(): never {
  throw new Error("400 Your credit balance is too low to access the Anthropic API.");
}

type Clasificar = (texto: string, contexto?: ContextoConversacion) => Promise<IntentClassification>;

const abiertos: Server[] = [];

async function levantar(clasificar: Clasificar, extras: Partial<AppDeps> = {}) {
  const queue = new SerialConversationQueue({ onError: () => {} });
  const avisos: string[] = [];
  const alCliente: string[] = [];

  const deps = {
    catalog,
    conversationStateStore: new InMemoryConversationStateStore(),
    globalPauseStore: new InMemoryGlobalPauseStore(),
    lastInteractionStore: new InMemoryLastInteractionStore(),
    auditLog: new InMemoryAuditLogStore(),
    classifier: {
      classify: (texto: string, _catalogo: unknown, contexto?: ContextoConversacion) => clasificar(texto, contexto),
    },
    sender: {
      sendText: async (to: string, body: string) => {
        alCliente.push(`${to}: ${body}`);
        return { messageId: "wamid.salida" };
      },
      sendImage: async () => ({ messageId: "wamid.salida" }),
    },
    avisoDeFallos: new AvisoDeFallos({
      canal: {
        enviar: async (texto) => {
          avisos.push(texto);
        },
      },
      programar: () => () => {},
    }),
    whatsappAppSecret: APP_SECRET,
    backgroundQueue: queue,
    ...extras,
  } as unknown as AppDeps;

  const server = createServer(createRequestListener(deps));
  abiertos.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No levantó el server.");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    queue,
    auditLog: deps.auditLog,
    avisos,
    alCliente,
  };
}

function postear(baseUrl: string, texto: string, wamid: string, from = TELEFONO): Promise<Response> {
  const body = payload(from, texto, wamid);
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": firmar(body) },
    body,
  });
}

afterEach(async () => {
  await Promise.all(abiertos.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe("el audit log se escribe antes de clasificar", () => {
  it("cuando el clasificador arranca, lo que llegó ya está registrado", async () => {
    const auditLog = new InMemoryAuditLogStore();
    let enElMomento: AuditLogEntry[] = [];
    const banco = await levantar(
      async () => {
        enElMomento = await auditLog.readAll();
        return ANDA;
      },
      { auditLog }
    );

    await postear(banco.baseUrl, "Hola, ¿sigue disponible?", "wamid.UNO");
    await banco.queue.idle();

    expect(enElMomento).toHaveLength(1);
    expect(enElMomento[0]).toMatchObject({
      conversationId: TELEFONO,
      incomingMessage: "Hola, ¿sigue disponible?",
      messageId: "wamid.UNO",
      etapa: "recibido",
    });
  });

  // La escritura arranca sin `await` antes de encolar (por el orden de
  // llegada); la tarea es la que la espera. Con un disco lento, sin esa espera
  // el clasificador arrancaría antes de que quede el registro.
  it("aunque la escritura tarde, el clasificador no arranca hasta que terminó", async () => {
    class AuditLogLento extends InMemoryAuditLogStore {
      override async append(entrada: AuditLogEntry): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return super.append(entrada);
      }
    }
    const auditLog = new AuditLogLento();
    let enElMomento: AuditLogEntry[] = [];
    const banco = await levantar(
      async () => {
        enElMomento = await auditLog.readAll();
        return ANDA;
      },
      { auditLog }
    );

    await postear(banco.baseUrl, "hola", "wamid.UNO");
    await vi.waitFor(async () => expect(await auditLog.readAll()).toHaveLength(2));

    expect(enElMomento.map((e) => e.etapa)).toEqual(["recibido"]);
  });

  it("un mensaje que se procesa bien queda una sola vez al leerlo", async () => {
    const banco = await levantar(async () => ANDA);

    await postear(banco.baseUrl, "hola", "wamid.UNO");
    await banco.queue.idle();

    const crudo = await banco.auditLog.readAll();
    // En disco quedan las dos: la de llegada y la que lo resolvió.
    expect(crudo.map((e) => e.etapa)).toEqual(["recibido", undefined]);
    expect(crudo.every((e) => e.messageId === "wamid.UNO")).toBe(true);

    const colapsado = colapsarPorMensaje(crudo);
    expect(colapsado).toHaveLength(1);
    expect(colapsado[0].matchedIntentId).toBe("fallback_low_confidence");
  });
});

describe("si la clasificación falla (se acabó el crédito, como el 28/8)", () => {
  it("el mensaje queda como fallido, con el mismo messageId que su recibido", async () => {
    const banco = await levantar(async () => sinCredito());

    await postear(banco.baseUrl, "Hola, ¿sigue disponible?", "wamid.UNO");
    await banco.queue.idle();

    const crudo = await banco.auditLog.readAll();
    expect(crudo.map((e) => e.etapa)).toEqual(["recibido", "fallido"]);
    expect(crudo[1]).toMatchObject({
      messageId: "wamid.UNO",
      incomingMessage: "Hola, ¿sigue disponible?",
      escalatedToBroker: true,
    });
    expect(crudo[1].escalationReason).toContain("credit balance is too low");
    expect(colapsarPorMensaje(crudo).map((e) => e.etapa)).toEqual(["fallido"]);
  });

  it("al broker le llega el texto crudo, y al cliente nada", async () => {
    const banco = await levantar(async () => sinCredito());

    await postear(banco.baseUrl, "Hola, ¿sigue disponible?", "wamid.UNO");
    await banco.queue.idle();

    expect(banco.avisos).toHaveLength(1);
    expect(banco.avisos[0]).toContain(TELEFONO);
    expect(banco.avisos[0]).toContain("Hola, ¿sigue disponible?");
    expect(banco.alCliente).toEqual([]);
  });

  // Modo de fallo 1 del pre-mortem: si la API de Anthropic está caída, el
  // camino normal de aviso —que redacta un borrador con Claude— muere igual.
  it("el aviso no pasa por Claude: sale aunque el borrador también esté caído", async () => {
    const composeDraft = vi.fn(async () => {
      throw new Error("API de Anthropic caída");
    });
    const notify = vi.fn(async () => {});
    const banco = await levantar(async () => sinCredito(), {
      draftComposer: { composeDraft },
      brokerNotifier: { notify },
    });

    await postear(banco.baseUrl, "Hola, ¿sigue disponible?", "wamid.UNO");
    await banco.queue.idle();

    expect(banco.avisos).toHaveLength(1);
    expect(composeDraft).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("cuando vuelve a andar, el broker se entera", async () => {
    let caido = true;
    const banco = await levantar(async () => (caido ? sinCredito() : ANDA));

    await postear(banco.baseUrl, "primero", "wamid.UNO");
    await banco.queue.idle();
    caido = false;
    await postear(banco.baseUrl, "segundo", "wamid.DOS");
    await banco.queue.idle();

    expect(banco.avisos).toHaveLength(2);
    expect(banco.avisos[1]).toContain("volvió a procesar");
  });
});

// Modo de fallo 3 del pre-mortem: la escritura de "llegó" no puede tumbar el
// mensaje, o el bloque deja las cosas peor que antes.
describe("si no se puede escribir el recibido", () => {
  it("el mensaje se procesa igual", async () => {
    class AuditLogQueFallaLaPrimeraVez extends InMemoryAuditLogStore {
      private yaFallo = false;
      override async append(entrada: AuditLogEntry): Promise<void> {
        if (!this.yaFallo) {
          this.yaFallo = true;
          throw new Error("disco lleno");
        }
        return super.append(entrada);
      }
    }
    const clasificados: string[] = [];
    const banco = await levantar(
      async (texto) => {
        clasificados.push(texto);
        return ANDA;
      },
      { auditLog: new AuditLogQueFallaLaPrimeraVez() }
    );

    await postear(banco.baseUrl, "hola", "wamid.UNO");
    await banco.queue.idle();

    expect(clasificados).toEqual(["hola"]);
    const crudo = await banco.auditLog.readAll();
    expect(crudo).toHaveLength(1);
    expect(crudo[0].etapa).toBeUndefined();
  });
});

// Modo de fallo 2 del pre-mortem, y un caso que no estaba en él: el `recibido`
// del mensaje actual ya está en el audit log cuando se arma el contexto.
describe("el contexto del clasificador", () => {
  it("no repite los mensajes anteriores ni incluye el mensaje actual", async () => {
    const contextos: Array<ContextoConversacion | undefined> = [];
    const banco = await levantar(async (_texto, contexto) => {
      contextos.push(contexto);
      return ANDA;
    });

    await postear(banco.baseUrl, "primer mensaje", "wamid.UNO");
    await banco.queue.idle();
    await postear(banco.baseUrl, "segundo mensaje", "wamid.DOS");
    await banco.queue.idle();

    // En el primero no hay nada anterior: si apareciera algo, sería él mismo.
    expect(contextos[0]).toBeUndefined();
    // En el segundo, el primero aparece una sola vez, aunque en disco tenga dos entradas.
    expect(contextos[1]?.mensajesPrevios).toEqual(["primer mensaje"]);
  });

  // Hallazgo de la revisión del PR: el `recibido` se escribe al llegar, así
  // que los mensajes que esperan en la cola ya están en el audit log cuando se
  // procesa el anterior.
  it("en una ráfaga, no incluye los mensajes que llegaron después y esperan en la cola", async () => {
    let soltar!: () => void;
    const retenido = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const contextos = new Map<string, ContextoConversacion | undefined>();
    const banco = await levantar(async (texto, contexto) => {
      contextos.set(texto, contexto);
      if (texto === "primero") await retenido;
      return ANDA;
    });

    await postear(banco.baseUrl, "primero", "wamid.UNO");
    await postear(banco.baseUrl, "segundo", "wamid.DOS");
    await postear(banco.baseUrl, "tercero", "wamid.TRES");
    // Los tres `recibido` están escritos mientras el primero sigue clasificándose.
    await vi.waitFor(async () => expect(await banco.auditLog.readAll()).toHaveLength(3));
    soltar();
    await banco.queue.idle();

    expect(contextos.get("segundo")?.mensajesPrevios).toEqual(["primero"]);
    expect(contextos.get("tercero")?.mensajesPrevios).toEqual(["primero", "segundo"]);
  });

  it("sí incluye un mensaje anterior que falló: el cliente lo escribió", async () => {
    const contextos: Array<ContextoConversacion | undefined> = [];
    let caido = true;
    const banco = await levantar(async (_texto, contexto) => {
      if (caido) sinCredito();
      contextos.push(contexto);
      return ANDA;
    });

    await postear(banco.baseUrl, "quiero ver el de Palermo", "wamid.UNO");
    await banco.queue.idle();
    caido = false;
    await postear(banco.baseUrl, "hola?", "wamid.DOS");
    await banco.queue.idle();

    expect(contextos[0]?.mensajesPrevios).toEqual(["quiero ver el de Palermo"]);
  });
});

// Hallazgo de la revisión del PR: con un `await` de la escritura antes de
// encolar, el orden de la cola pasaba a ser el de las escrituras a disco.
describe("el orden de llegada", () => {
  it("se respeta aunque la escritura del primer mensaje tarde más que la del segundo", async () => {
    class AuditLogLentoAlPrincipio extends InMemoryAuditLogStore {
      private primera = true;
      override async append(entrada: AuditLogEntry): Promise<void> {
        if (this.primera) {
          this.primera = false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return super.append(entrada);
      }
    }
    const orden: string[] = [];
    const banco = await levantar(
      async (texto) => {
        orden.push(texto);
        return ANDA;
      },
      { auditLog: new AuditLogLentoAlPrincipio() }
    );

    await postear(banco.baseUrl, "uno", "wamid.UNO");
    await postear(banco.baseUrl, "dos", "wamid.DOS");
    await vi.waitFor(() => expect(orden).toHaveLength(2));

    expect(orden).toEqual(["uno", "dos"]);
  });
});

// Hallazgo de la revisión del PR: el aviso es una alarma sobre clientes sin
// respuesta. Una orden del broker que falla le decía "contestale vos" sobre su
// propio mensaje.
describe("los mensajes del broker", () => {
  const BROKER = "5491100000000";

  it("si fallan, quedan como fallido pero no disparan el aviso", async () => {
    const banco = await levantar(async () => sinCredito(), { brokerWhatsappNumber: BROKER });

    await postear(banco.baseUrl, "pausá el agente", "wamid.UNO", BROKER);
    await banco.queue.idle();

    expect(banco.avisos).toEqual([]);
    const crudo = await banco.auditLog.readAll();
    expect(crudo.map((e) => e.etapa)).toEqual(["recibido", "fallido"]);
  });

  // docs/TASKS.md Bloque 38g: la misma definición de "es el broker" que el
  // ruteo y el modo silencioso, que compara dígitos.
  it("se reconocen aunque el número del broker esté configurado con + y espacios", async () => {
    const banco = await levantar(async () => sinCredito(), { brokerWhatsappNumber: "+54 9 11 0000-0000" });

    await postear(banco.baseUrl, "pausá el agente", "wamid.UNO", BROKER);
    await banco.queue.idle();

    expect(banco.avisos).toEqual([]);
  });

  it("si fallan, no cuentan para agrupar los fallos de clientes", async () => {
    const banco = await levantar(async () => sinCredito(), { brokerWhatsappNumber: BROKER });

    for (let i = 1; i <= 5; i++) {
      await postear(banco.baseUrl, `orden ${i}`, `wamid.B${i}`, BROKER);
    }
    await banco.queue.idle();
    await postear(banco.baseUrl, "Hola, ¿sigue disponible?", "wamid.CLIENTE");
    await banco.queue.idle();

    // Es el primer fallo de un cliente: sale suelto y enseguida.
    expect(banco.avisos).toHaveLength(1);
    expect(banco.avisos[0]).toContain("Hola, ¿sigue disponible?");
    expect(banco.avisos[0]).not.toContain("resumen");
  });
});

// docs/TASKS.md Bloque 38d. El handler registra la respuesta antes de que
// app.ts la mande. Si el envío fallaba, la tarea tiraba y la cola solo lo
// escribía en consola: el audit log decía que había salido, no había aviso, y
// pendientes la daba por respondida.
describe("si mandar la respuesta falla", () => {
  const BROKER = "5491100000000";

  function senderQueFalla(falla: { texto?: boolean; fotos?: boolean }) {
    const enviados: string[] = [];
    return {
      enviados,
      sender: {
        sendText: async (_to: string, body: string) => {
          if (falla.texto) throw new Error("401 el token venció");
          enviados.push(body);
          return { messageId: "wamid.salida" };
        },
        sendImage: async (_to: string, url: string) => {
          // Motivos distintos a propósito: el primero es el que explica el
          // problema y no puede perderse detrás del último.
          if (falla.fotos) throw new Error(url.endsWith("1.jpg") ? "401 el token venció" : "404 media vencida");
          enviados.push(url);
          return { messageId: "wamid.salida" };
        },
        sendTemplate: async () => ({ messageId: "wamid.salida" }),
      },
    };
  }

  it("el mensaje queda como envío fallido, no como respondido, y te llega el aviso", async () => {
    const { sender } = senderQueFalla({ texto: true });
    const banco = await levantar(async () => ANDA, { sender } as unknown as Partial<AppDeps>);

    await postear(banco.baseUrl, "Hola, ¿sigue disponible?", "wamid.UNO");
    await banco.queue.idle();

    // Una sola entrada resuelta, escrita DESPUÉS del envío: dice que no salió.
    const [vista] = colapsarPorMensaje(await banco.auditLog.readAll());
    expect(vista.responseSent).toBeUndefined();
    expect(vista.envio).toBe("fallo");
    expect(vista.envioMotivo).toContain("token venció");
    expect(banco.avisos).toHaveLength(1);
    expect(banco.avisos[0]).toContain("Hola, ¿sigue disponible?");
    // El mensaje sí se procesó: decirle "no pude procesarlo" sería falso.
    expect(banco.avisos[0]).toContain("NO pude mandarle la respuesta");
    expect(banco.avisos[0]).not.toContain("No pude procesar");
  });

  // Hallazgo de la revisión del PR #41: el cliente no vio la respuesta, así que
  // un "ok" suyo no puede confirmar lo que el handler dejó armado.
  it("si el envío falla, la conversación no queda esperando confirmación", async () => {
    const { sender } = senderQueFalla({ texto: true });
    const conversationStateStore = new InMemoryConversationStateStore();
    const propiedad = {
      id: "prop-1",
      tokkoId: "tokko-1",
      direccion: "Av. Santa Fe 3253",
      direccionCorta: "Depto Palermo",
      tipo: "departamento",
      estado: "disponible",
      precio: 350000,
      fotos: [],
    };
    const banco = await levantar(
      async () => ({ intentId: "agendar_visita", confidence: 0.95, searchQuery: "Palermo" }),
      {
        sender,
        conversationStateStore,
        tokko: { searchProperties: async () => [propiedad], getProperty: async () => propiedad },
        gcal: { freebusy: async () => [], createEvent: async () => ({ id: "evt-1" }) },
        composer: { compose: async () => "Tengo estos horarios: jueves 10, viernes 11." },
      } as unknown as Partial<AppDeps>
    );

    await postear(banco.baseUrl, "quiero ir a verlo", "wamid.UNO");
    await banco.queue.idle();

    const estado = await conversationStateStore.get(TELEFONO);
    expect(estado?.step ?? "idle").toBe("idle");
  });

  it("después de una caída, un envío que falla no dispara el aviso de que volvió", async () => {
    let caido = true;
    const { sender } = senderQueFalla({ texto: true });
    const banco = await levantar(async () => (caido ? sinCredito() : ANDA), { sender } as unknown as Partial<AppDeps>);

    await postear(banco.baseUrl, "primero", "wamid.UNO");
    await banco.queue.idle();
    caido = false;
    await postear(banco.baseUrl, "segundo", "wamid.DOS");
    await banco.queue.idle();

    expect(banco.avisos).toHaveLength(2);
    expect(banco.avisos.some((aviso) => aviso.includes("volvió a procesar"))).toBe(false);
    expect(banco.avisos[1]).toContain("segundo");
  });

  it("cuando el envío vuelve a andar, recién ahí avisa que volvió", async () => {
    let falla = true;
    const banco = await levantar(async () => ANDA, {
      sender: {
        sendText: async () => {
          if (falla) throw new Error("401 el token venció");
          return { messageId: "wamid.salida" };
        },
        sendImage: async () => ({ messageId: "wamid.salida" }),
      },
    } as unknown as Partial<AppDeps>);

    await postear(banco.baseUrl, "primero", "wamid.UNO");
    await banco.queue.idle();
    falla = false;
    await postear(banco.baseUrl, "segundo", "wamid.DOS");
    await banco.queue.idle();

    expect(banco.avisos).toHaveLength(2);
    expect(banco.avisos[1]).toContain("volvió a procesar");
  });

  // Modo de fallo 2 del pre-mortem.
  it("si fallan las fotos pero el texto salió, no se avisa que no se le respondió nada", async () => {
    const { sender, enviados } = senderQueFalla({ fotos: true });
    const propiedad = {
      id: "prop-1",
      tokkoId: "tokko-1",
      direccion: "Av. Santa Fe 3253",
      direccionCorta: "Depto Palermo",
      tipo: "departamento",
      estado: "disponible",
      precio: 350000,
      fotos: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
    };
    const banco = await levantar(
      async () => ({ intentId: "pedido_ficha_multimedia", confidence: 0.95, searchQuery: "Palermo" }),
      {
        sender,
        tokko: { searchProperties: async () => [propiedad], getProperty: async () => propiedad },
      } as unknown as Partial<AppDeps>
    );

    await postear(banco.baseUrl, "¿me pasás fotos del de Palermo?", "wamid.UNO");
    await banco.queue.idle();

    expect(enviados).toEqual(["Te paso el material de Depto Palermo:"]);
    const [vista] = colapsarPorMensaje(await banco.auditLog.readAll());
    expect(vista.envio).toBe("parcial");
    expect(vista.responseSent).toBe("Te paso el material de Depto Palermo:");
    expect(vista.envioMotivo).toContain("2 de 2 fotos");
    // Los dos motivos, no solo el último.
    expect(vista.envioMotivo).toContain("401 el token venció");
    expect(vista.envioMotivo).toContain("404 media vencida");
    // El aviso lo dice como es: el texto salió.
    expect(banco.avisos).toHaveLength(1);
    expect(banco.avisos[0]).toContain("Le llegó el texto, pero no todo");
    expect(banco.avisos[0]).not.toContain("NO se le respondió nada");
    // Y no se da por recuperado: no salió todo.
    expect(banco.avisos.some((aviso) => aviso.includes("volvió a procesar"))).toBe(false);
  });

  // El SilentModeSender no tira: devuelve la marca. Sin mirarla, el audit log
  // diría que la respuesta salió (hallazgo de la revisión del PR #41).
  it("un envío que el modo silencioso bloquea cuenta como fallo, aunque no tire", async () => {
    const banco = await levantar(async () => ANDA, {
      sender: {
        sendText: async () => ({ raw: { messaging_product: "whatsapp" }, bloqueado: "modo_silencioso" }),
        sendImage: async () => ({ raw: { messaging_product: "whatsapp" }, bloqueado: "modo_silencioso" }),
      },
    } as unknown as Partial<AppDeps>);

    await postear(banco.baseUrl, "Hola", "wamid.UNO");
    await banco.queue.idle();

    const [vista] = colapsarPorMensaje(await banco.auditLog.readAll());
    expect(vista.responseSent).toBeUndefined();
    expect(vista.envio).toBe("fallo");
    expect(vista.envioMotivo).toContain("modo silencioso");
  });

  // Modo de fallo 3 del pre-mortem.
  it("una respuesta al broker que no se pudo mandar queda registrada, sin aviso", async () => {
    const { sender } = senderQueFalla({ texto: true });
    const banco = await levantar(async () => ANDA, {
      sender,
      brokerWhatsappNumber: BROKER,
    } as unknown as Partial<AppDeps>);

    await postear(banco.baseUrl, "¿cómo viene la agenda?", "wamid.UNO", BROKER);
    await banco.queue.idle();

    expect(banco.avisos).toEqual([]);
    const [vista] = colapsarPorMensaje(await banco.auditLog.readAll());
    expect(vista.envio).toBe("fallo");
    expect(vista.responseSent).toBeUndefined();
  });

  // Modo de fallo 1 del pre-mortem, visto desde el Bloque 31: una plantilla
  // fija que no salió no puede gastar el único envío por conversación.
  it("un envío fallido no gasta el único envío de la plantilla fija", async () => {
    let falla = true;
    const enviados: string[] = [];
    const banco = await levantar(async () => ({ intentId: "reclamo_queja", confidence: 0.9 }), {
      sender: {
        sendText: async (_to: string, body: string) => {
          if (falla) throw new Error("401 el token venció");
          enviados.push(body);
          return { messageId: "wamid.salida" };
        },
        sendImage: async () => ({ messageId: "wamid.salida" }),
      },
    } as unknown as Partial<AppDeps>);
    const plantilla = catalog.intents.find((i) => i.id === "reclamo_queja")!.response.template!;

    await postear(banco.baseUrl, "esto es un desastre", "wamid.UNO");
    await banco.queue.idle();
    falla = false;
    await postear(banco.baseUrl, "sigo esperando", "wamid.DOS");
    await banco.queue.idle();

    expect(enviados).toEqual([plantilla]);
  });
});
