import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { IntentCatalog } from "shared-types";
import { parseIncomingMessage } from "./channels/whatsapp/webhookPayload.js";
import { verifyWebhookChallenge, verifyWebhookSignature } from "./channels/whatsapp/signature.js";
import type { WhatsAppSender } from "./channels/whatsapp/sender.js";
import type { IntentClassifier } from "./agent/classifier.js";
import type { ResponseComposer } from "./agent/composer.js";
import type { AuditLogStore } from "./agent/auditLog.js";
import type { TokkoQueries } from "./mcp/tokkoMcpClient.js";
import { handleIncomingMessage } from "./agent/handleIncomingMessage.js";

export interface AppDeps {
  catalog: IntentCatalog;
  classifier: IntentClassifier;
  composer: ResponseComposer;
  auditLog: AuditLogStore;
  tokko: TokkoQueries;
  sender?: WhatsAppSender;
  whatsappWebhookVerifyToken?: string;
  whatsappAppSecret?: string;
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
  return async (req, res) => {
    try {
      await route(req, res, deps);
    } catch (error) {
      console.error("Error manejando request:", error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    }
  };
}

async function route(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
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
    await handleIncomingWebhook(req, res, deps);
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
  deps: AppDeps
): Promise<void> {
  const rawBody = await readRawBody(req);

  if (deps.whatsappAppSecret) {
    const signatureHeader = req.headers["x-hub-signature-256"];
    const valid = verifyWebhookSignature(
      rawBody,
      Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader,
      deps.whatsappAppSecret
    );
    if (!valid) {
      res.writeHead(401);
      res.end();
      return;
    }
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
  if (message) {
    try {
      const result = await handleIncomingMessage(message, {
        catalog: deps.catalog,
        classifier: deps.classifier,
        composer: deps.composer,
        tokko: deps.tokko,
        auditLog: deps.auditLog,
      });
      if (deps.sender) {
        await deps.sender.sendText(message.from, result.responseText);
      }
    } catch (error) {
      // No dejamos caer el webhook por un intent sin handler todavía o un
      // error de un tool: se loguea y no se responde nada a este mensaje.
      console.error("Error procesando mensaje entrante:", error);
    }
  }

  // Siempre 200 a Meta para que no reintente el webhook indefinidamente.
  sendJson(res, 200, { received: true });
}
