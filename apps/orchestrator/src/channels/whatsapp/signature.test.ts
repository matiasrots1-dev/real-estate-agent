import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeWebhookRequest, verifyWebhookChallenge, verifyWebhookSignature } from "./signature.js";

describe("verifyWebhookSignature", () => {
  const appSecret = "test-app-secret";
  const body = Buffer.from(JSON.stringify({ hello: "world" }));

  function sign(secret: string, payload: Buffer): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }

  it("acepta una firma válida", () => {
    expect(verifyWebhookSignature(body, sign(appSecret, body), appSecret)).toBe(true);
  });

  it("rechaza una firma calculada con otro secret", () => {
    expect(verifyWebhookSignature(body, sign("otro-secret", body), appSecret)).toBe(false);
  });

  it("rechaza si el body fue alterado después de firmar", () => {
    const signature = sign(appSecret, body);
    const tamperedBody = Buffer.from(JSON.stringify({ hello: "mundo" }));
    expect(verifyWebhookSignature(tamperedBody, signature, appSecret)).toBe(false);
  });

  it("rechaza si falta el header o no tiene el prefijo sha256=", () => {
    expect(verifyWebhookSignature(body, undefined, appSecret)).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=algo", appSecret)).toBe(false);
  });
});

describe("authorizeWebhookRequest", () => {
  const appSecret = "test-app-secret";
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const firmaValida = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
  const firmaInvalida = `sha256=${createHmac("sha256", "otro").update(body).digest("hex")}`;

  describe("con el flag APAGADO (default)", () => {
    it("acepta una firma válida y lo dice", () => {
      expect(
        authorizeWebhookRequest({ rawBody: body, signatureHeader: firmaValida, appSecret })
      ).toEqual({ aceptado: true, motivo: "firma_valida" });
    });

    it("rechaza una firma inválida distinguiéndola de una ausente", () => {
      expect(
        authorizeWebhookRequest({ rawBody: body, signatureHeader: firmaInvalida, appSecret })
      ).toEqual({ aceptado: false, motivo: "firma_invalida" });

      expect(
        authorizeWebhookRequest({ rawBody: body, signatureHeader: undefined, appSecret })
      ).toEqual({ aceptado: false, motivo: "firma_ausente" });
    });

    // El agujero silencioso que ya existía antes de este bloque: sin App
    // Secret no hay contra qué validar y todo pasa igual. Se testea para que
    // quede explícito que apagar el flag NO alcanza por sí solo.
    it("sin App Secret acepta cualquier cosa, y el motivo lo delata", () => {
      expect(
        authorizeWebhookRequest({ rawBody: body, signatureHeader: undefined, appSecret: undefined })
      ).toEqual({ aceptado: true, motivo: "sin_secreto_configurado" });

      expect(
        authorizeWebhookRequest({ rawBody: body, signatureHeader: firmaInvalida, appSecret: "" })
      ).toEqual({ aceptado: true, motivo: "sin_secreto_configurado" });
    });
  });

  describe("con el flag PRENDIDO", () => {
    it("acepta un POST sin ninguna firma — el caso del reenvío del proveedor", () => {
      expect(
        authorizeWebhookRequest({
          rawBody: body,
          signatureHeader: undefined,
          appSecret,
          skipSignatureCheck: true,
        })
      ).toEqual({ aceptado: true, motivo: "validacion_salteada_por_flag" });
    });

    it("acepta también una firma inválida: el flag apaga la validación entera", () => {
      expect(
        authorizeWebhookRequest({
          rawBody: body,
          signatureHeader: firmaInvalida,
          appSecret,
          skipSignatureCheck: true,
        })
      ).toEqual({ aceptado: true, motivo: "validacion_salteada_por_flag" });
    });

    // Si una firma válida se reportara como "firma_valida" estando el flag
    // prendido, el log de la ventana insegura mostraría tráfico "verificado"
    // que en realidad nadie verificó.
    it("aun con firma válida reporta que la validación estuvo apagada", () => {
      expect(
        authorizeWebhookRequest({
          rawBody: body,
          signatureHeader: firmaValida,
          appSecret,
          skipSignatureCheck: true,
        })
      ).toEqual({ aceptado: true, motivo: "validacion_salteada_por_flag" });
    });
  });
});

describe("verifyWebhookChallenge", () => {
  it("devuelve el challenge si el modo y el token coinciden", () => {
    const result = verifyWebhookChallenge(
      { "hub.mode": "subscribe", "hub.verify_token": "correcto", "hub.challenge": "1234" },
      "correcto"
    );
    expect(result).toBe("1234");
  });

  it("devuelve null si el token no coincide", () => {
    const result = verifyWebhookChallenge(
      { "hub.mode": "subscribe", "hub.verify_token": "incorrecto", "hub.challenge": "1234" },
      "correcto"
    );
    expect(result).toBeNull();
  });

  it("devuelve null si el modo no es subscribe", () => {
    const result = verifyWebhookChallenge(
      { "hub.mode": "unsubscribe", "hub.verify_token": "correcto", "hub.challenge": "1234" },
      "correcto"
    );
    expect(result).toBeNull();
  });
});
