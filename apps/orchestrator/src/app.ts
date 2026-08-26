import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  describirPayloadSinMensaje,
  esEcoDeCoexistencia,
  parseIncomingMessage,
} from "./channels/whatsapp/webhookPayload.js";
import { InMemoryWebhookMetrics, type WebhookMetrics } from "./webhookMetrics.js";
import {
  authorizeWebhookRequest,
  verifyWebhookChallenge,
  HEADER_SECRETO_PROVEEDOR,
} from "./channels/whatsapp/signature.js";
import { handleIncomingMessage, type HandleMessageDeps } from "./agent/handleIncomingMessage.js";
import { SerialConversationQueue, type BackgroundQueue } from "./backgroundQueue.js";
import { LruMessageDeduplicator, type MessageDeduplicator } from "./messageDedup.js";
import { extraerContactosSalientes } from "./channels/whatsapp/ecoContacto.js";
import type { UltimoContactoStore } from "./agent/ultimoContactoStore.js";
import type { ContactosConocidos } from "./agent/contactosConocidos.js";

export interface AppDeps extends HandleMessageDeps {
  whatsappWebhookVerifyToken?: string;
  whatsappAppSecret?: string;
  /** Secreto compartido con el proveedor (header `X-DoubleTick-Secret`). */
  webhookProviderSecret?: string;
  /**
   * Acepta webhooks sin firma HMAC. Temporal, apagado por default — ver el
   * riesgo abierto en docs/TASKS.md. Con esto prendido el endpoint no
   * distingue a Meta de cualquiera que conozca la URL.
   */
  skipWebhookSignatureCheck?: boolean;
  /**
   * Dónde se procesa el mensaje después de haber respondido 200. Inyectable
   * para que los tests puedan **esperar** el trabajo en vuelo (`idle()`) en
   * vez de dormir un rato y cruzar los dedos. Si no se pasa, cada listener
   * crea la suya — nunca una global, que se filtraría entre tests.
   */
  backgroundQueue?: BackgroundQueue;
  /**
   * Filtro de mensajes ya vistos, por `id` de Meta. Inyectable para los tests;
   * si no se pasa, cada listener crea el suyo.
   */
  messageDeduplicator?: MessageDeduplicator;
  /**
   * Contador de qué pasó con cada POST. Inyectable para los tests; si no se
   * pasa, cada listener crea el suyo. Se expone en `GET /health`.
   */
  webhookMetrics?: WebhookMetrics;
  /**
   * De dónde salen las propiedades: `real` o `mock`. Se resuelve una vez al
   * arrancar y se expone en `GET /health`, para poder confirmarlo sin depender
   * de un banner en la terminal — los logs de un server MCP por stdio no
   * llegan a la consola de quien levantó el orchestrator.
   */
  tokkoFuente?: { fuente: string; branchId: number | null };
  /**
   * Dónde se registra que el broker contactó a alguien **a mano desde su
   * celular**, vía el eco de coexistencia. Sin esto el sistema no se entera y
   * puede recontactar a alguien con quien el broker habló ayer.
   */
  ultimoContactoStore?: UltimoContactoStore;
  /**
   * Filtro de privacidad del eco: sólo se registra el contacto si el
   * destinatario ya escribió al agente alguna vez. Sin esto se armaría una
   * base de "a quién le escribió el broker" que incluye su vida personal.
   */
  contactosConocidos?: ContactosConocidos;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Handler HTTP puro (sin abrir el socket) para poder testearlo contra un
 * servidor efímero real en tests, sin depender de server.ts ni de
 * credenciales reales.
 */
export function createRequestListener(deps: AppDeps): RequestListener {
  const queue = deps.backgroundQueue ?? new SerialConversationQueue();
  const dedup = deps.messageDeduplicator ?? new LruMessageDeduplicator();
  const metrics = deps.webhookMetrics ?? new InMemoryWebhookMetrics();
  return async (req, res) => {
    try {
      await route(req, res, deps, queue, dedup, metrics);
    } catch (error) {
      console.error("Error manejando request:", error);
      // Con el ACK adelantado, para cuando algo falla acá la respuesta ya salió
      // en el camino feliz. El guard de headersSent deja de ser una formalidad.
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    }
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppDeps,
  queue: BackgroundQueue,
  dedup: MessageDeduplicator,
  metrics: WebhookMetrics
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    // El resumen va acá para poder preguntarle al sistema "¿cuántos webhooks
    // recibí y qué pasó con cada uno?" sin depender del scrollback de una
    // terminal que ya se cerró — que es exactamente lo que faltó el 2026-08-12.
    sendJson(res, 200, { ok: true, tokko: deps.tokkoFuente ?? { fuente: "desconocido", branchId: null }, webhook: metrics.resumen() });
    return;
  }

  if (url.pathname !== "/webhook") {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === "GET") {
    handleVerification(url, res, deps);
    return;
  }

  if (req.method === "POST") {
    await handleIncomingWebhook(req, res, deps, queue, dedup, metrics);
    return;
  }

  res.writeHead(405);
  res.end();
}

function handleVerification(url: URL, res: ServerResponse, deps: AppDeps): void {
  if (!deps.whatsappWebhookVerifyToken) {
    res.writeHead(403);
    res.end();
    return;
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const challenge = verifyWebhookChallenge(query, deps.whatsappWebhookVerifyToken);
  if (challenge === null) {
    res.writeHead(403);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(challenge);
}

async function handleIncomingWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppDeps,
  queue: BackgroundQueue,
  dedup: MessageDeduplicator,
  metrics: WebhookMetrics
): Promise<void> {
  const rawBody = await readRawBody(req);

  const rawSignature = req.headers["x-hub-signature-256"];
  const rawProviderSecret = req.headers[HEADER_SECRETO_PROVEEDOR];
  const auth = authorizeWebhookRequest({
    rawBody,
    signatureHeader: Array.isArray(rawSignature) ? rawSignature[0] : rawSignature,
    appSecret: deps.whatsappAppSecret,
    providerSecretHeader: Array.isArray(rawProviderSecret) ? rawProviderSecret[0] : rawProviderSecret,
    providerSecret: deps.webhookProviderSecret,
    skipSignatureCheck: deps.skipWebhookSignatureCheck,
  });

  // Todo POST a /webhook deja rastro de por qué se aceptó o se rechazó. Antes
  // el rechazo era un 401 mudo: si Meta (o un reenviador) mandaba algo que no
  // validaba, del lado nuestro no quedaba absolutamente nada para diagnosticar.
  // Nunca se loguea el body: trae teléfonos y el texto del mensaje.
  if (!auth.aceptado) {
    metrics.registrar(
      auth.motivo === "firma_invalida"
        ? "rechazado_firma_invalida"
        : auth.motivo === "firma_ausente"
          ? "rechazado_firma_ausente"
          : auth.motivo === "secreto_proveedor_invalido"
            ? "rechazado_secreto_proveedor"
            : "rechazado_sin_secreto"
    );
    console.warn(
      `[webhook] RECHAZADO (401) motivo=${auth.motivo} bytes=${rawBody.length} ` +
        `header_presente=${rawSignature !== undefined}` +
        // Este motivo tiene el mismo síntoma que el blocker del Bloque 11 ("no
        // llega nada"), que costó días de diagnóstico. El log dice qué hacer.
        (auth.motivo === "sin_secreto_configurado"
          ? " -> cargá WHATSAPP_APP_SECRET en .env; se rechaza TODO hasta entonces"
          : "")
    );
    res.writeHead(401);
    res.end();
    return;
  }

  if (auth.motivo !== "firma_valida") {
    console.warn(
      `[webhook] ACEPTADO SIN VERIFICAR FIRMA motivo=${auth.motivo} bytes=${rawBody.length}. ` +
        `Este request pudo venir de cualquiera, no necesariamente de Meta.`
    );
  }

  let json: unknown;
  try {
    json = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf-8")) : {};
  } catch {
    // Antes salía en absoluto silencio: un reenviador mandando algo mal
    // formado era indistinguible de no recibir nada.
    metrics.registrar("json_invalido");
    console.warn(`[webhook] DESCARTADO (400) motivo=json_invalido bytes=${rawBody.length}`);
    res.writeHead(400);
    res.end();
    return;
  }

  // Espejo de coexistencia (`smb_message_echoes`): lo que el broker mandó
  // desde su propio celular, que Meta nos reenvía. Se descarta ACÁ, explícito
  // y antes de parsear, en vez de confiar en que el payload no traiga
  // `value.messages` — apoyarse en la ausencia de una clave es depender de que
  // Meta nunca cambie la forma. Si el eco alguna vez viniera con `messages`,
  // como sale del número del broker caería en el canal `broker` y el agente
  // leería lo que el broker le escribe a un cliente como una orden para él.
  const esEco = esEcoDeCoexistencia(json);
  const message = esEco ? null : parseIncomingMessage(json);

  // El 200 sale ACÁ, antes de procesar. El proveedor que reenvía los webhooks
  // corta a los 3 segundos y el camino completo (clasificar con Claude ~1.7-2.2s,
  // tools, redactar, enviar) tarda bastante más: procesando primero nos cortaban
  // por timeout y, peor, reintentaban mientras seguíamos procesando el original,
  // así que el cliente podía recibir la misma respuesta dos o tres veces.
  sendJson(res, 200, { received: true });

  // El punto ciego más grande de los cuatro: acá caen los webhooks de status
  // de Meta (sent/delivered/read), que son varios por cada mensaje saliente, y
  // los tipos de mensaje que no soportamos. Es la mayor parte del volumen y no
  // dejaba ni una línea. `describirPayloadSinMensaje` mira sólo la FORMA del
  // payload, nunca su contenido.
  if (esEco) {
    metrics.registrar("eco_descartado");
    console.log(`[webhook] eco de coexistencia descartado bytes=${rawBody.length}`);

    // El eco se sigue descartando como mensaje entrante — el canal broker no
    // se toca. Lo único que se aprovecha es "el broker le escribió a esta
    // persona en este momento", que es lo que evita recontactar a alguien con
    // quien acaba de hablar.
    //
    // Va al background y no acá: ya respondimos 200 y esto no puede demorar
    // ni romper la respuesta.
    if (deps.ultimoContactoStore && deps.contactosConocidos) {
      const { ultimoContactoStore: store, contactosConocidos: conocidos } = deps;
      for (const contacto of extraerContactosSalientes(json)) {
        // Filtro de privacidad: sólo se registra si ya es un contacto del
        // negocio. La vida personal del broker no entra al sistema.
        if (!conocidos.conoce(contacto.telefono)) continue;
        queue.enqueue(contacto.telefono, async () => {
          await store.registrar(contacto.telefono, contacto.cuando, "manual");
        });
      }
    }
    return;
  }

  if (!message) {
    const tipo = describirPayloadSinMensaje(json);
    metrics.registrar("sin_mensaje", tipo);
    console.log(`[webhook] sin mensaje procesable tipo=${tipo} bytes=${rawBody.length}`);
    return;
  }

  // Meta reintenta el POST cuando el webhook del proveedor devuelve un no-200,
  // y como el forward del proveedor está enganchado ANTES de su propio CRM, el
  // reintento nos llega de nuevo con el mismo id. Sin este filtro el cliente
  // recibe la respuesta dos veces (o las veces que Meta reintente).
  //
  // Va después del 200: a un duplicado también hay que confirmarle recepción.
  // Contestarle un no-200 haría que Meta reintente todavía más.
  // Quien nos escribe pasa a ser un contacto conocido: a partir de ahí, si el
  // broker le responde desde el celular, ese contacto sí se registra.
  deps.contactosConocidos?.agregar(message.from);

  if (!dedup.registrarSiEsNuevo(message.messageId)) {
    metrics.registrar("duplicado");
    return;
  }

  metrics.registrar("procesado");

  // Encolado por conversación: dos mensajes seguidos del mismo teléfono se
  // procesan uno después del otro. Sin esto, al contestar rápido se pierde la
  // serialización que antes daba de casualidad la lentitud del handler, y los
  // stores JSON (leer-entero → mutar → escribir-entero, sin lock) se pisan.
  queue.enqueue(message.from, async () => {
    const result = await handleIncomingMessage(message, deps);
    // responseText es null cuando el agente está pausado para este
    // cliente (docs/TASKS.md Bloque 9) — el mensaje ya quedó auditado
    // adentro de handleIncomingMessage, acá simplemente no hay nada que mandar.
    if (deps.sender && result.responseText !== null) {
      await deps.sender.sendText(message.from, result.responseText);
      for (const mediaUrl of result.mediaUrls ?? []) {
        await deps.sender.sendImage(message.from, mediaUrl);
      }
    }
  });
}
