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

describe("loadConfigFromEnv — modo silencioso", () => {
  // Es el único flag del proyecto cuyo default es `true`. La asimetría:
  // silencioso cuando lo querías activo = te llegan los borradores y respondés
  // a mano, y te enterás en el acto. Activo cuando lo querías silencioso =
  // mensajes de un bot a personas reales, y no se deshace (2026-08-12).
  it("viene PRENDIDO cuando la variable no está", () => {
    expect(loadConfigFromEnv({}).modoSilencioso).toBe(true);
  });

  it('se apaga sólo con el string exacto "false"', () => {
    expect(loadConfigFromEnv({ AGENTE_MODO_SILENCIOSO: "false" }).modoSilencioso).toBe(false);
  });

  it.each(["", "0", "no", "FALSE", "False", "true", " false", "apagado"])(
    "queda prendido con el valor %o",
    (valor) => {
      expect(loadConfigFromEnv({ AGENTE_MODO_SILENCIOSO: valor }).modoSilencioso).toBe(true);
    }
  );
});
