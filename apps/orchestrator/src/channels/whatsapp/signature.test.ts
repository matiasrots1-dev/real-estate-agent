import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookChallenge, verifyWebhookSignature } from "./signature.js";

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
