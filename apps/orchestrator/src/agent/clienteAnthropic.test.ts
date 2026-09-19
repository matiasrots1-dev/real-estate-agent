// docs/TASKS.md Bloque 38b: una llamada a Anthropic que se cuelga tiene que
// convertirse en error en un tiempo acotado, no en media hora.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  crearClienteAnthropic,
  leerTimeoutAnthropic,
  REINTENTOS_ANTHROPIC,
  TIMEOUT_ANTHROPIC_MS,
} from "./clienteAnthropic.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Un `fetch` que nunca responde: solo se entera si lo abortan. */
function fetchColgado(): typeof fetch {
  return ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;
}

describe("crearClienteAnthropic", () => {
  it("por default, 30 s por intento y 2 reintentos", () => {
    const cliente = crearClienteAnthropic({ apiKey: "sk-test" });

    expect(cliente.timeout).toBe(TIMEOUT_ANTHROPIC_MS);
    expect(TIMEOUT_ANTHROPIC_MS).toBe(30_000);
    expect(cliente.maxRetries).toBe(REINTENTOS_ANTHROPIC);
  });

  // Modo de fallo 2 del pre-mortem: la opción tiene que llegar de verdad a la
  // llamada. Se prueba con el SDK real, no mirando una propiedad.
  it("una llamada que se cuelga tira por timeout, en vez de esperar", async () => {
    const cliente = crearClienteAnthropic({ apiKey: "sk-test", timeoutMs: 50, maxRetries: 0, fetch: fetchColgado() });
    const inicio = Date.now();

    await expect(
      cliente.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "hola" }],
      })
    ).rejects.toThrow(/timed out/i);

    expect(Date.now() - inicio).toBeLessThan(5_000);
  });
});

// Modo de fallo 3 del pre-mortem: un typo en el .env no puede tumbar el bot.
describe("leerTimeoutAnthropic", () => {
  it("sin la variable, usa el default", () => {
    expect(leerTimeoutAnthropic(undefined)).toBe(TIMEOUT_ANTHROPIC_MS);
    expect(leerTimeoutAnthropic("")).toBe(TIMEOUT_ANTHROPIC_MS);
  });

  it("un entero positivo se respeta", () => {
    expect(leerTimeoutAnthropic("45000")).toBe(45_000);
  });

  it("un valor inválido se ignora con un aviso, en vez de romper al crear el cliente", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const malo of ["30s", "0", "-5", "1.5", "abc"]) {
      const valor = leerTimeoutAnthropic(malo);
      expect(valor).toBe(TIMEOUT_ANTHROPIC_MS);
      // Y el cliente se puede crear con lo que devolvió.
      expect(() => crearClienteAnthropic({ apiKey: "sk-test", timeoutMs: valor })).not.toThrow();
    }
    expect(warn).toHaveBeenCalledTimes(5);
  });
});

// Modo de fallo 2 del pre-mortem: un segundo cliente creado en otro lado
// volvería a esperar 10 minutos sin que nada lo note.
describe("el cliente de Anthropic se crea en un solo lugar", () => {
  it("ningún archivo del orchestrator, fuera de clienteAnthropic.ts, hace new Anthropic(", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const archivos: string[] = [];
    const recorrer = (dir: string) => {
      for (const nombre of readdirSync(dir)) {
        const ruta = path.join(dir, nombre);
        if (statSync(ruta).isDirectory()) recorrer(ruta);
        else if (nombre.endsWith(".ts") && !nombre.endsWith(".test.ts")) archivos.push(ruta);
      }
    };
    recorrer(src);

    const conOtroCliente = archivos.filter(
      (ruta) => !ruta.endsWith(`${path.sep}clienteAnthropic.ts`) && /new\s+Anthropic\s*\(/.test(readFileSync(ruta, "utf8"))
    );

    expect(archivos.length).toBeGreaterThan(20);
    expect(conOtroCliente.map((ruta) => path.relative(src, ruta))).toEqual([]);
  });
});
