// docs/TASKS.md Bloque 38b: una llamada a Anthropic que se cuelga tiene que
// convertirse en error en un tiempo acotado, no en media hora, y antes de que
// la cola abandone la tarea.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crearClienteAnthropic } from "./clienteAnthropic.js";
import {
  leerTimeoutAnthropic,
  REINTENTOS_ANTHROPIC,
  TIMEOUT_ANTHROPIC_MAX_MS,
  TIMEOUT_ANTHROPIC_MS,
} from "./limitesAnthropic.js";
import { DEFAULT_TASK_TIMEOUT_MS } from "../backgroundQueue.js";

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
  it("por default, 25 s por intento y 1 reintento", () => {
    const cliente = crearClienteAnthropic({ apiKey: "sk-test" });

    expect(cliente.timeout).toBe(25_000);
    expect(cliente.maxRetries).toBe(1);
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

// Hallazgo de la revisión del PR #39: con 30 s y 2 reintentos, una llamada
// colgada fallaba a los ~91 s y la cola la abandonaba a los 60 s, antes de
// que se escribiera el `fallido`.
describe("el timeout de Anthropic cierra con el techo de la cola", () => {
  /** El mensaje más lento medido en producción (19/09), entero. */
  const MENSAJE_MAS_LENTO_MS = 18_400;
  /** La espera del SDK entre intentos, con margen. */
  const ESPERA_ENTRE_INTENTOS_MS = 2_000;

  it.each([
    ["el default", TIMEOUT_ANTHROPIC_MS],
    ["el máximo que acepta el .env", TIMEOUT_ANTHROPIC_MAX_MS],
  ])("con %s, una llamada colgada falla antes de que la cola abandone la tarea", (_nombre, timeoutMs) => {
    const peorCaso = (1 + REINTENTOS_ANTHROPIC) * timeoutMs + REINTENTOS_ANTHROPIC * ESPERA_ENTRE_INTENTOS_MS;

    expect(MENSAJE_MAS_LENTO_MS + peorCaso).toBeLessThan(DEFAULT_TASK_TIMEOUT_MS);
  });
});

// Modo de fallo 3 del pre-mortem: un error en el .env no puede tumbar el bot
// ni hacer fallar todas las llamadas.
describe("leerTimeoutAnthropic", () => {
  it("sin la variable, usa el default", () => {
    expect(leerTimeoutAnthropic(undefined)).toBe(TIMEOUT_ANTHROPIC_MS);
    expect(leerTimeoutAnthropic("")).toBe(TIMEOUT_ANTHROPIC_MS);
  });

  it("un entero dentro del rango se respeta", () => {
    expect(leerTimeoutAnthropic("1000")).toBe(1_000);
    expect(leerTimeoutAnthropic("20000")).toBe(20_000);
    expect(leerTimeoutAnthropic("30000")).toBe(30_000);
  });

  it("un valor inválido o fuera de rango se ignora con un aviso", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // "30": segundos por error, haría fallar todas las llamadas. "0x7530" y
    // "1e10" pasan Number.isInteger. "3000000000" desborda setTimeout.
    const malos = ["30", "0", "-5", "1.5", "abc", "30s", "0x7530", "1e10", "3000000000", "40000"];

    for (const malo of malos) {
      const valor = leerTimeoutAnthropic(malo);
      expect(valor, malo).toBe(TIMEOUT_ANTHROPIC_MS);
      expect(() => crearClienteAnthropic({ apiKey: "sk-test", timeoutMs: valor })).not.toThrow();
    }
    expect(warn).toHaveBeenCalledTimes(malos.length);
  });
});

/**
 * Los constructores del SDK que aparecen en un archivo: los nombres con que
 * se importó `@anthropic-ai/sdk` (con alias incluidos, sin los `import type`)
 * y cada `new` de alguno de ellos, sin contar comentarios.
 */
function clientesDeAnthropicEn(codigo: string): string[] {
  const sinComentarios = codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // "Anthropic" cuenta siempre, se haya importado como sea.
  const nombres = new Set<string>(["Anthropic"]);
  const importacion = /import\s+(?!type\b)([^;]*?)\s+from\s+["']@anthropic-ai\/sdk["']/g;
  for (const [, clausula] of sinComentarios.matchAll(importacion)) {
    const porDefecto = /^([A-Za-z_$][\w$]*)/.exec(clausula.trim());
    if (porDefecto) nombres.add(porDefecto[1]);
    const llaves = /\{([^}]*)\}/.exec(clausula);
    for (const parte of llaves?.[1].split(",") ?? []) {
      const [original, alias] = parte.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (original === "Anthropic") nombres.add((alias ?? original).trim());
    }
  }
  return [...nombres].filter((nombre) => new RegExp(`new\\s+${nombre.replace(/\$/g, "\\$")}\\s*\\(`).test(sinComentarios));
}

// Modo de fallo 2 del pre-mortem: un segundo cliente creado en otro lado
// volvería a esperar 10 minutos sin que nada lo note.
describe("el cliente de Anthropic se crea en un solo lugar", () => {
  it("la guarda reconoce un cliente importado con otro nombre, e ignora los comentarios", () => {
    expect(clientesDeAnthropicEn(`import Claude from "@anthropic-ai/sdk";\nconst c = new Claude({ apiKey });`)).toEqual(["Claude"]);
    expect(clientesDeAnthropicEn(`import { Anthropic as A } from "@anthropic-ai/sdk";\nnew A({});`)).toEqual(["A"]);
    expect(clientesDeAnthropicEn(`import Anthropic from "@anthropic-ai/sdk";\n// ojo: no hacer new Anthropic( acá`)).toEqual([]);
    expect(clientesDeAnthropicEn(`import type Anthropic from "@anthropic-ai/sdk";\nlet x: Anthropic;`)).toEqual([]);
  });

  it("ningún archivo del orchestrator, fuera de clienteAnthropic.ts, crea un cliente", () => {
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
      (ruta) => !ruta.endsWith(`${path.sep}clienteAnthropic.ts`) && clientesDeAnthropicEn(readFileSync(ruta, "utf8")).length > 0
    );

    expect(archivos.length).toBeGreaterThan(20);
    expect(conOtroCliente.map((ruta) => path.relative(src, ruta))).toEqual([]);
  });
});
