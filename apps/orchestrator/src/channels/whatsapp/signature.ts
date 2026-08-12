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

/**
 * Por qué se acepta o se rechaza un POST a /webhook. Es un tipo aparte, y no
 * un boolean, para que quien loguea pueda distinguir "lo dejé pasar porque la
 * firma estaba bien" de "lo dejé pasar porque alguien apagó la validación" —
 * son la misma respuesta HTTP y consecuencias de seguridad opuestas.
 */
export type WebhookAuthOutcome =
  | { aceptado: true; motivo: "firma_valida" }
  | { aceptado: true; motivo: "validacion_salteada_por_flag" }
  | { aceptado: false; motivo: "firma_ausente" | "firma_invalida" | "sin_secreto_configurado" };

export interface WebhookAuthOptions {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  appSecret: string | undefined;
  /**
   * Escotilla de escape temporal (docs/TASKS.md, riesgo abierto): acepta
   * webhooks SIN firma. Existe sólo para poder probar contra un reenviador
   * intermediario que no puede firmar como Meta. Default apagado.
   */
  skipSignatureCheck?: boolean;
}

/**
 * Decide si un POST a /webhook se procesa o se rechaza. Separado del handler
 * HTTP para poder testear la matriz completa (flag × secreto × firma) sin
 * levantar un servidor.
 */
export function authorizeWebhookRequest(options: WebhookAuthOptions): WebhookAuthOutcome {
  // El flag va PRIMERO y a propósito: cuando está prendido no se mira la
  // firma ni aunque venga bien, así el motivo logueado siempre refleja que la
  // validación estuvo apagada. Si mirara la firma primero, un request bien
  // firmado se loguearía como "firma_valida" y la ventana insegura quedaría
  // invisible en el log justo cuando más importa verla.
  if (options.skipSignatureCheck) {
    return { aceptado: true, motivo: "validacion_salteada_por_flag" };
  }

  // Sin App Secret no hay nada contra qué validar, así que se RECHAZA. Antes
  // se aceptaba: era la segunda forma de quedar sin verificación de firma, no
  // requería prender ningún flag y era completamente silenciosa — bastaba con
  // que la variable estuviera vacía. Desactivar la validación tiene que ser un
  // acto deliberado (el flag de arriba), nunca el resultado de un `.env`
  // incompleto.
  if (!options.appSecret) {
    return { aceptado: false, motivo: "sin_secreto_configurado" };
  }

  if (!options.signatureHeader) {
    return { aceptado: false, motivo: "firma_ausente" };
  }

  const valida = verifyWebhookSignature(options.rawBody, options.signatureHeader, options.appSecret);
  return valida
    ? { aceptado: true, motivo: "firma_valida" }
    : { aceptado: false, motivo: "firma_invalida" };
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
