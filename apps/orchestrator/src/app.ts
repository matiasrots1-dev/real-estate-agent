import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { parseIncomingMessage } from "./channels/whatsapp/webhookPayload.js";
import { authorizeWebhookRequest, verifyWebhookChallenge } from "./channels/whatsapp/signature.js";
import { handleIncomingMessage, type HandleMessageDeps } from "./agent/handleIncomingMessage.js";
import { SerialConversationQueue, type BackgroundQueue } from "./backgroundQueue.js";
import { LruMessageDeduplicator, type MessageDeduplicator } from "./messageDedup.js";

export interface AppDeps extends HandleMessageDeps {
  whatsappWebhookVerifyToken?: string;
  whatsappAppSecret?: string;
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
  return async (req, res) => {
    try {
      await route(req, res, deps, queue, dedup);
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
  dedup: MessageDeduplicator
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
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
    await handleIncomingWebhook(req, res, deps, queue, dedup);
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
  dedup: MessageDeduplicator
): Promise<void> {
  const rawBody = await readRawBody(req);

  const rawSignature = req.headers["x-hub-signature-256"];
  const auth = authorizeWebhookRequest({
    rawBody,
    signatureHeader: Array.isArray(rawSignature) ? rawSignature[0] : rawSignature,
    appSecret: deps.whatsappAppSecret,
    skipSignatureCheck: deps.skipWebhookSignatureCheck,
  });

  // Todo POST a /webhook deja rastro de por qué se aceptó o se rechazó. Antes
  // el rechazo era un 401 mudo: si Meta (o un reenviador) mandaba algo que no
  // validaba, del lado nuestro no quedaba absolutamente nada para diagnosticar.
  // Nunca se loguea el body: trae teléfonos y el texto del mensaje.
  if (!auth.aceptado) {
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
    res.writeHead(400);
    res.end();
    return;
  }

  const message = parseIncomingMessage(json);

  // El 200 sale ACÁ, antes de procesar. El proveedor que reenvía los webhooks
  // corta a los 3 segundos y el camino completo (clasificar con Claude ~1.7-2.2s,
  // tools, redactar, enviar) tarda bastante más: procesando primero nos cortaban
  // por timeout y, peor, reintentaban mientras seguíamos procesando el original,
  // así que el cliente podía recibir la misma respuesta dos o tres veces.
  sendJson(res, 200, { received: true });

  if (!message) return;

  // Meta reintenta el POST cuando el webhook del proveedor devuelve un no-200,
  // y como el forward del proveedor está enganchado ANTES de su propio CRM, el
  // reintento nos llega de nuevo con el mismo id. Sin este filtro el cliente
  // recibe la respuesta dos veces (o las veces que Meta reintente).
  //
  // Va después del 200: a un duplicado también hay que confirmarle recepción.
  // Contestarle un no-200 haría que Meta reintente todavía más.
  if (!dedup.registrarSiEsNuevo(message.messageId)) return;

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
