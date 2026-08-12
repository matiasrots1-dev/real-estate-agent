// El flag WHATSAPP_WEBHOOK_SKIP_SIGNATURE_CHECK, probado a nivel HTTP real y
// no sólo en la función pura de signature.ts.
//
// Por qué existe este archivo aparte: el modo de fallo que importa acá no es
// "la función decide mal", es "la función decide bien pero el flag no está
// cableado hasta el handler". Un test de la función pura pasa en verde en los
// dos casos. Es la misma lección del Bloque 10 (docs/TASKS.md): 255 tests
// verdes sobre un gate que en vivo no funcionaba.
//
// Se usa un payload que es JSON válido pero no contiene ningún mensaje, así el
// handler corta en parseIncomingMessage y nunca toca al agente: lo único bajo
// prueba es la puerta de entrada.

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestListener, type AppDeps } from "./app.js";

const APP_SECRET = "test-app-secret";
const PAYLOAD = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

function firmar(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Deps mínimas: con un payload sin mensajes el handler jamás llega a usar el
 * resto, así que no hace falta levantar MCP servers ni stubbear al agente.
 */
function deps(overrides: Partial<AppDeps>): AppDeps {
  return { whatsappAppSecret: APP_SECRET, ...overrides } as unknown as AppDeps;
}

const abiertos: Server[] = [];

async function levantar(appDeps: AppDeps): Promise<string> {
  const server = createServer(createRequestListener(appDeps));
  abiertos.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No levantó el server de test.");
  return `http://127.0.0.1:${address.port}`;
}

async function postear(baseUrl: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: PAYLOAD,
  });
  return res.status;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    abiertos.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe("puerta de entrada de /webhook", () => {
  describe("con el flag apagado (default de producción)", () => {
    it("un POST sin firma se rechaza con 401", async () => {
      const baseUrl = await levantar(deps({}));
      expect(await postear(baseUrl, {})).toBe(401);
    });

    it("un POST con firma inválida se rechaza con 401", async () => {
      const baseUrl = await levantar(deps({}));
      const status = await postear(baseUrl, {
        "X-Hub-Signature-256": firmar(PAYLOAD, "secreto-equivocado"),
      });
      expect(status).toBe(401);
    });

    it("un POST bien firmado pasa", async () => {
      const baseUrl = await levantar(deps({}));
      const status = await postear(baseUrl, {
        "X-Hub-Signature-256": firmar(PAYLOAD, APP_SECRET),
      });
      expect(status).toBe(200);
    });

    it("el rechazo deja rastro en el log, no es un 401 mudo", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const baseUrl = await levantar(deps({}));

      await postear(baseUrl, {});

      expect(warn).toHaveBeenCalledTimes(1);
      const linea = String(warn.mock.calls[0]?.[0]);
      expect(linea).toContain("RECHAZADO");
      expect(linea).toContain("firma_ausente");
    });

    it("distingue en el log una firma ausente de una inválida", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const baseUrl = await levantar(deps({}));

      await postear(baseUrl, { "X-Hub-Signature-256": firmar(PAYLOAD, "secreto-equivocado") });

      expect(String(warn.mock.calls[0]?.[0])).toContain("firma_invalida");
    });

    it("no loguea nada cuando la firma es válida: el log queda para lo anómalo", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const baseUrl = await levantar(deps({}));

      await postear(baseUrl, { "X-Hub-Signature-256": firmar(PAYLOAD, APP_SECRET) });

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("con el flag prendido", () => {
    it("acepta un POST sin ninguna firma — el reenvío del proveedor", async () => {
      const baseUrl = await levantar(deps({ skipWebhookSignatureCheck: true }));
      expect(await postear(baseUrl, {})).toBe(200);
    });

    it("acepta también una firma inválida", async () => {
      const baseUrl = await levantar(deps({ skipWebhookSignatureCheck: true }));
      const status = await postear(baseUrl, {
        "X-Hub-Signature-256": firmar(PAYLOAD, "secreto-equivocado"),
      });
      expect(status).toBe(200);
    });

    // El log por request es lo que evita que la ventana insegura quede
    // invisible: el aviso del arranque queda enterrado cuando el proceso
    // lleva horas corriendo.
    it("avisa en CADA request que se aceptó sin verificar", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const baseUrl = await levantar(deps({ skipWebhookSignatureCheck: true }));

      await postear(baseUrl, {});
      await postear(baseUrl, {});

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain("ACEPTADO SIN VERIFICAR FIRMA");
      expect(String(warn.mock.calls[0]?.[0])).toContain("validacion_salteada_por_flag");
    });

    it("nunca loguea el body: trae teléfonos y el texto del mensaje", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const baseUrl = await levantar(deps({ skipWebhookSignatureCheck: true }));

      await postear(baseUrl, {});

      const todo = warn.mock.calls.flat().join(" ");
      expect(todo).not.toContain("whatsapp_business_account");
    });
  });

  // Este caso no requiere prender ningún flag y ya existía antes del bloque:
  // sin App Secret no hay contra qué validar y todo entra igual.
  describe("sin App Secret cargado", () => {
    it("acepta sin firma aunque el flag esté apagado, y lo dice en el log", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const baseUrl = await levantar(deps({ whatsappAppSecret: undefined }));

      expect(await postear(baseUrl, {})).toBe(200);
      expect(String(warn.mock.calls[0]?.[0])).toContain("sin_secreto_configurado");
    });
  });
});
