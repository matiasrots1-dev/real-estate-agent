import { describe, expect, it } from "vitest";
import { loadConfigFromEnv } from "./config.js";

describe("loadConfigFromEnv — flag de firma del webhook", () => {
  it("viene apagado cuando la variable no está", () => {
    expect(loadConfigFromEnv({}).whatsapp.skipWebhookSignatureCheck).toBe(false);
  });

  it('se prende sólo con el string exacto "true"', () => {
    const config = loadConfigFromEnv({ WHATSAPP_WEBHOOK_SKIP_SIGNATURE_CHECK: "true" });
    expect(config.whatsapp.skipWebhookSignatureCheck).toBe(true);
  });

  // Un flag que apaga un control de seguridad tiene que fallar hacia el lado
  // seguro ante cualquier valor ambiguo. "1" o "yes" leídos como verdaderos
  // dejarían el webhook abierto por un typo en .env.
  it.each(["", "1", "yes", "TRUE", "True", "false", "sí", " true"])(
    'queda apagado con el valor %o',
    (valor) => {
      const config = loadConfigFromEnv({ WHATSAPP_WEBHOOK_SKIP_SIGNATURE_CHECK: valor });
      expect(config.whatsapp.skipWebhookSignatureCheck).toBe(false);
    }
  );
});
