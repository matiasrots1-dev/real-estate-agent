import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Valida el header X-Hub-Signature-256 que Meta manda en cada webhook,
 * calculado como HMAC-SHA256 del body crudo (raw bytes, antes de parsear
 * JSON) usando el App Secret. Sin esto, cualquiera podría pegarle a
 * nuestro endpoint haciéndose pasar por Meta.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

export interface WebhookVerificationQuery {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
}

/**
 * Handshake GET que Meta hace una sola vez al configurar el webhook.
 * Devuelve el challenge a ecoar si el modo y el token coinciden, o null
 * si hay que rechazar la verificación.
 */
export function verifyWebhookChallenge(
  query: WebhookVerificationQuery,
  expectedVerifyToken: string
): string | null {
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === expectedVerifyToken) {
    return query["hub.challenge"] ?? "";
  }
  return null;
}
