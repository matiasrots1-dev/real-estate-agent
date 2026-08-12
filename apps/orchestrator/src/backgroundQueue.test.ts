// Tests de la cola con promesas controladas a mano, no con timers ni sleeps:
// "esperar 50ms y ver qué pasó" es verde en una máquina y rojo en otra, y no
// prueba el orden, prueba la velocidad relativa. Acá cada tarea se libera
// explícitamente y las aserciones son sobre hechos, no sobre tiempos.

import { describe, expect, it, vi } from "vitest";
import { SerialConversationQueue } from "./backgroundQueue.js";

/** Una promesa que resuelve/rechaza cuando el test lo decide. */
function diferida() {
  let resolver!: () => void;
  let rechazar!: (error: unknown) => void;
  const promesa = new Promise<void>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

describe("SerialConversationQueue", () => {
  describe("serialización por conversación", () => {
    it("no arranca el segundo mensaje del mismo teléfono hasta que termina el primero", async () => {
      const cola = new SerialConversationQueue();
      const primera = diferida();
      const arrancaron: string[] = [];

      cola.enqueue("549111", async () => {
        arrancaron.push("a");
        await primera.promesa;
      });
      cola.enqueue("549111", async () => {
        arrancaron.push("b");
      });

      // Dejar correr el microtask queue: si hubiera paralelismo, "b" ya estaría.
      await Promise.resolve();
      await Promise.resolve();
      expect(arrancaron).toEqual(["a"]);

      primera.resolver();
      await cola.idle();
      expect(arrancaron).toEqual(["a", "b"]);
    });

    it("conversaciones distintas no se bloquean entre sí", async () => {
      const cola = new SerialConversationQueue();
      const bloqueada = diferida();
      const arrancaron: string[] = [];

      cola.enqueue("549111", async () => {
        arrancaron.push("a");
        await bloqueada.promesa;
      });
      cola.enqueue("549222", async () => {
        arrancaron.push("b");
      });

      await Promise.resolve();
      await Promise.resolve();
      // "b" es de otro teléfono: no tiene por qué esperar a "a".
      expect(arrancaron).toContain("b");

      bloqueada.resolver();
      await cola.idle();
    });

    it("mantiene el orden de llegada dentro de la misma conversación", async () => {
      const cola = new SerialConversationQueue();
      const terminaron: number[] = [];

      for (let i = 0; i < 5; i++) {
        cola.enqueue("549111", async () => {
          await Promise.resolve();
          terminaron.push(i);
        });
      }

      await cola.idle();
      expect(terminaron).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe("contención de errores", () => {
    it("una tarea que lanza no impide que corra la siguiente de la misma conversación", async () => {
      const onError = vi.fn();
      const cola = new SerialConversationQueue({ onError });
      const corrio: string[] = [];

      cola.enqueue("549111", async () => {
        throw new Error("intent sin handler");
      });
      cola.enqueue("549111", async () => {
        corrio.push("siguiente");
      });

      await cola.idle();
      expect(corrio).toEqual(["siguiente"]);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("una tarea que lanza de forma sincrónica también queda contenida", async () => {
      const onError = vi.fn();
      const cola = new SerialConversationQueue({ onError });

      cola.enqueue("549111", () => {
        throw new Error("explotó antes del primer await");
      });

      await cola.idle();
      expect(onError).toHaveBeenCalledTimes(1);
    });

    // Este es el punto 1 del pedido: que un mensaje raro no mate el proceso.
    // Si algo escapara de la cola sería un unhandledRejection, y Node 24
    // termina el proceso por default.
    it("nunca deja una promesa rechazada suelta", async () => {
      const rechazosSueltos: unknown[] = [];
      const capturar = (razon: unknown) => rechazosSueltos.push(razon);
      process.on("unhandledRejection", capturar);

      try {
        const cola = new SerialConversationQueue({ onError: () => {} });
        cola.enqueue("549111", async () => {
          throw new Error("falla fea");
        });
        cola.enqueue("549222", () => Promise.reject(new Error("otra falla fea")));
        await cola.idle();
        // Dar una vuelta más para que un rechazo no manejado llegue a emitirse.
        await new Promise((r) => setTimeout(r, 10));
      } finally {
        process.off("unhandledRejection", capturar);
      }

      expect(rechazosSueltos).toEqual([]);
    });

    it("si el propio reporte de error explota, tampoco se propaga", async () => {
      const cola = new SerialConversationQueue({
        onError: () => {
          throw new Error("la consola también está rota");
        },
      });

      cola.enqueue("549111", async () => {
        throw new Error("falla original");
      });

      await expect(cola.idle()).resolves.toBeUndefined();
    });

    it("no loguea el id de conversación: es un teléfono", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const cola = new SerialConversationQueue();

      cola.enqueue("5491155551234", async () => {
        throw new Error("falla");
      });
      await cola.idle();

      expect(error.mock.calls.flat().join(" ")).not.toContain("5491155551234");
      error.mockRestore();
    });
  });

  describe("watchdog", () => {
    it("libera la cadena cuando una tarea nunca resuelve, en vez de trabarla para siempre", async () => {
      const onError = vi.fn();
      const cola = new SerialConversationQueue({ taskTimeoutMs: 20, onError });
      const corrio: string[] = [];

      // Nunca resuelve: simula una llamada HTTP colgada.
      cola.enqueue("549111", () => new Promise<void>(() => {}));
      cola.enqueue("549111", async () => {
        corrio.push("el mensaje siguiente igual se atiende");
      });

      await cola.idle();
      expect(corrio).toEqual(["el mensaje siguiente igual se atiende"]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0]?.[0])).toContain("superó");
    });
  });

  describe("idle()", () => {
    // Modo de fallo 3 del pre-mortem: un idle() que espera sólo las cadenas
    // que existían al entrar resuelve antes de tiempo, y los tests que lo usen
    // pasan en verde sin haber esperado nada.
    it("espera también el trabajo que una tarea encola mientras corre", async () => {
      const cola = new SerialConversationQueue();
      const terminaron: string[] = [];

      cola.enqueue("549111", async () => {
        terminaron.push("primera");
        cola.enqueue("549222", async () => {
          terminaron.push("encolada desde adentro");
          cola.enqueue("549333", async () => {
            terminaron.push("y otra más, dos niveles adentro");
          });
        });
      });

      await cola.idle();
      expect(terminaron).toEqual([
        "primera",
        "encolada desde adentro",
        "y otra más, dos niveles adentro",
      ]);
      expect(cola.pending()).toBe(0);
    });

    it("resuelve al toque si no hay nada pendiente", async () => {
      const cola = new SerialConversationQueue();
      await expect(cola.idle()).resolves.toBeUndefined();
    });
  });

  // Modo de fallo 2 del pre-mortem: una entrada por teléfono que no se limpia
  // es una fuga en un proceso que corre semanas.
  describe("no acumula estado", () => {
    it("suelta las cadenas terminadas", async () => {
      const cola = new SerialConversationQueue();

      for (let i = 0; i < 200; i++) {
        cola.enqueue(`5491100000${i}`, async () => {});
      }
      await cola.idle();

      expect(cola.pending()).toBe(0);
      // El mapa interno no es público; se verifica por su efecto observable:
      // sin trabajo pendiente no puede quedar ninguna cadena viva.
      expect(cola["cadenas"].size).toBe(0);
    });

    it("no borra la entrada si mientras tanto se encoló otra tarea", async () => {
      const cola = new SerialConversationQueue();
      const primera = diferida();
      const corrio: string[] = [];

      cola.enqueue("549111", async () => {
        corrio.push("a");
        await primera.promesa;
      });
      cola.enqueue("549111", async () => {
        corrio.push("b");
      });

      primera.resolver();
      await cola.idle();

      expect(corrio).toEqual(["a", "b"]);
      expect(cola["cadenas"].size).toBe(0);
    });
  });
});
