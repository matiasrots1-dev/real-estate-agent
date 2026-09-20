import { describe, expect, it, vi } from "vitest";
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

// docs/TASKS.md Bloque 38b.
describe("loadConfigFromEnv — timeout de Anthropic", () => {
  it("sin la variable, 25 s", () => {
    expect(loadConfigFromEnv({}).anthropicTimeoutMs).toBe(25_000);
  });

  it("con la variable, su valor", () => {
    expect(loadConfigFromEnv({ ANTHROPIC_TIMEOUT_MS: "20000" }).anthropicTimeoutMs).toBe(20_000);
  });
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

// docs/TASKS.md Bloque 40, modo de fallo 1: con la hora rota la retención no
// correría nunca, y eso se ve exactamente igual que una corrida que no borró
// nada. Se ignora el valor y se avisa, en vez de propagarlo.
describe("loadConfigFromEnv — la hora de la retención", () => {
  it("por default corre a las 4 de la mañana", () => {
    expect(loadConfigFromEnv({}).retention.hora).toBe(4);
  });

  it("toma la hora configurada", () => {
    expect(loadConfigFromEnv({ RETENTION_HORA: "6" }).retention.hora).toBe(6);
  });

  // La medianoche es una hora válida, y `0` no puede caer en el default.
  it("las 00:00 valen", () => {
    expect(loadConfigFromEnv({ RETENTION_HORA: "0" }).retention.hora).toBe(0);
  });

  it.each(["25", "-1", "4.5", "cuatro", ""])("ignora %o y usa el default", (valor) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfigFromEnv({ RETENTION_HORA: valor }).retention.hora).toBe(4);
    // El vacío no es un error de configuración: es "no está puesta".
    if (valor !== "") expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("conserva 90 días de reportes por default", () => {
    expect(loadConfigFromEnv({}).retention.diasDeReportes).toBe(90);
    expect(loadConfigFromEnv({ RETENTION_DIAS_DE_REPORTES: "30" }).retention.diasDeReportes).toBe(30);
  });
});

// Hallazgo de la revisión del PR #46: la hora se validaba y los plazos no.
// `Number("abc")` es NaN, y un NaN en los meses apaga la purga sin decir nada
// (las comparaciones contra una fecha inválida dan todas falso); uno en los
// días hace que el reporte no se recorte nunca. El síntoma es el mismo que el
// de no tener nada que borrar.
describe("loadConfigFromEnv — los plazos de la retención", () => {
  it("los defaults son los de la política publicada", () => {
    const { retention } = loadConfigFromEnv({});
    expect(retention.mesesMensajes).toBe(12);
    expect(retention.mesesGestionComercial).toBe(24);
  });

  it("toma los plazos configurados", () => {
    const { retention } = loadConfigFromEnv({
      RETENTION_MESES_MENSAJES: "6",
      RETENTION_MESES_GESTION_COMERCIAL: "18",
    });
    expect(retention.mesesMensajes).toBe(6);
    expect(retention.mesesGestionComercial).toBe(18);
  });

  it.each(["abc", "0", "-3", ""])("un plazo inválido (%o) no apaga la purga en silencio", (valor) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { retention } = loadConfigFromEnv({
      RETENTION_MESES_MENSAJES: valor,
      RETENTION_DIAS_DE_REPORTES: valor,
    });
    expect(retention.mesesMensajes).toBe(12);
    expect(retention.diasDeReportes).toBe(90);
    if (valor !== "") expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
