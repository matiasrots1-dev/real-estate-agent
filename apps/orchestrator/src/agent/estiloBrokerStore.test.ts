import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

/** Ver el comentario del mismo doble en jsonFileStore.test.ts. */
let renameFalla = false;
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    default: real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (renameFalla) throw new Error("EPERM: el antivirus lo tiene abierto");
      return real.rename(...args);
    },
  };
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileEstiloBrokerStore,
  InMemoryEstiloBrokerStore,
  sirveComoEjemplo,
  type EjemploDeEstilo,
} from "./estiloBrokerStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../../..");

describe("corpus de estilo", () => {
  it("devuelve los mas recientes del intent pedido", async () => {
    const s = new InMemoryEstiloBrokerStore();
    await s.guardar({ intent: "agendar_visita", texto: "viejo", cuando: "2026-01-01T00:00:00.000Z" });
    await s.guardar({ intent: "agendar_visita", texto: "nuevo", cuando: "2026-08-01T00:00:00.000Z" });
    await s.guardar({ intent: "reclamo_queja", texto: "otro intent", cuando: "2026-08-02T00:00:00.000Z" });

    const r = await s.ejemplosDe("agendar_visita", 5);

    expect(r.map((e) => e.texto)).toEqual(["nuevo", "viejo"]);
  });

  it("respeta el limite de cuantos ejemplos se piden", async () => {
    const s = new InMemoryEstiloBrokerStore();
    for (let i = 0; i < 10; i++) {
      await s.guardar({ intent: "x", texto: `t${i}`, cuando: `2026-08-0${(i % 9) + 1}T00:00:00.000Z` });
    }

    expect((await s.ejemplosDe("x", 3)).length).toBe(3);
  });

  describe("que sirve como ejemplo", () => {
    it("descarta lo demasiado corto: no ensena tono", () => {
      expect(sirveComoEjemplo("ok")).toBe(false);
      expect(sirveComoEjemplo("dale")).toBe(false);
    });

    it("descarta lo demasiado largo: se come el prompt", () => {
      expect(sirveComoEjemplo("a".repeat(700))).toBe(false);
    });

    it("acepta un mensaje normal", () => {
      expect(sirveComoEjemplo("Perfecto, lo coordinamos para el jueves entonces")).toBe(true);
    });
  });

  // DECISION EXPLICITA del dueno del repo: el corpus se conserva sin plazo,
  // porque va anonimizado y sin destinatario. Este test existe para que nadie
  // lo cablee al barrido de retencion por inercia, viendo que los demas stores
  // si estan.
  describe("no se purga por antiguedad", () => {
    it("el job de retencion NO lo incluye", () => {
      const retention = fs.readFileSync(path.join(REPO, "apps/orchestrator/src/jobs/retention.ts"), "utf-8");

      expect(retention.toLowerCase()).not.toContain("estilo");
    });

    // El metodo sigue existiendo aunque nadie lo llame: es la via para vaciar
    // el corpus si la decision se revisa, o para un pedido puntual de borrado.
    it("pero se puede vaciar a mano si hace falta", async () => {
      const s = new InMemoryEstiloBrokerStore();
      await s.guardar({ intent: "x", texto: "algo viejo", cuando: "2020-01-01T00:00:00.000Z" });

      const r = await s.purgeOlderThan(new Date("2026-01-01"), false);

      expect(r.borrados).toBe(1);
      expect(await s.all()).toHaveLength(0);
    });

    // El reporte de purgado no puede ser una copia de lo que borra: en este
    // store el registro ES el texto.
    it("el reporte de purgado no incluye el texto", async () => {
      const s = new InMemoryEstiloBrokerStore();
      await s.guardar({ intent: "x", texto: "un texto identificable", cuando: "2020-01-01T00:00:00.000Z" });

      const r = await s.purgeOlderThan(new Date("2026-01-01"), true);

      expect(JSON.stringify(r)).not.toContain("identificable");
    });
  });
});

// docs/TASKS.md Bloque 41. El corpus no se puede reconstruir: el texto crudo
// del broker nunca toca el disco, sólo su forma anonimizada. Una línea rota
// hacía que `all()` devolviera [], y `estilo:reanonimizar` —que hace `all()`
// y después `reescribir()`— escribía entonces un archivo vacío.
describe("corpus de estilo en disco", () => {
  const ejemplo = (over: Partial<EjemploDeEstilo> = {}): EjemploDeEstilo => ({
    intent: "consulta_disponibilidad",
    texto: "Sí, sigue disponible. ¿Querés que coordinemos?",
    cuando: "2026-09-01T10:00:00.000Z",
    ...over,
  });
  const linea = (e: EjemploDeEstilo) => `${JSON.stringify(e)}\n`;

  let dir: string;
  let archivo: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "estilo-"));
    archivo = path.join(dir, "estilo_broker.jsonl");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("una línea rota no vacía el corpus", async () => {
    await writeFile(archivo, linea(ejemplo({ texto: "uno" })) + "{rota\n" + linea(ejemplo({ texto: "dos" })));

    const todos = await new FileEstiloBrokerStore(archivo).all();

    expect(todos.map((e) => e.texto)).toEqual(["uno", "dos"]);
  });

  it("y avisa una sola vez, con el número de línea", async () => {
    await writeFile(archivo, linea(ejemplo()) + "{rota\n");
    const store = new FileEstiloBrokerStore(archivo);

    await store.all();
    await store.all();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain("línea 2");
  });

  // El caso que hace urgente al bloque: con el `catch { return [] }` de antes,
  // esto dejaba el archivo vacío y se perdían los 112 ejemplos del servidor.
  it("reanonimizar con una línea rota NO borra los ejemplos buenos", async () => {
    await writeFile(archivo, linea(ejemplo({ texto: "uno" })) + "{rota\n" + linea(ejemplo({ texto: "dos" })));
    const store = new FileEstiloBrokerStore(archivo);

    const todos = await store.all();
    const { ilegiblesDescartadas } = await store.reescribir(todos.map((e) => ({ ...e, texto: e.texto + "!" })));

    expect(ilegiblesDescartadas).toBe(1);
    expect((await store.all()).map((e) => e.texto)).toEqual(["uno!", "dos!"]);
  });

  // La regla del Bloque 39 es conservar las rotas; acá no, y es deliberado:
  // reanonimizar existe para garantizar que TODO pasó por el anonimizador.
  it("reanonimizar descarta las líneas ilegibles en vez de conservarlas", async () => {
    await writeFile(archivo, "{rota\n" + linea(ejemplo({ texto: "uno" })));
    const store = new FileEstiloBrokerStore(archivo);

    await store.reescribir([ejemplo({ texto: "uno" })]);

    expect(await readFile(archivo, "utf-8")).toBe(linea(ejemplo({ texto: "uno" })));
  });

  // La purga sí las conserva: su objetivo es no perder ejemplos. La fecha de
  // una línea rota es la del próximo ejemplo legible (Bloque 37).
  it("la purga conserva la línea rota que quedó entre ejemplos vigentes", async () => {
    await writeFile(
      archivo,
      linea(ejemplo({ texto: "viejo", cuando: "2024-01-01T00:00:00.000Z" })) +
        "{rota\n" +
        linea(ejemplo({ texto: "nuevo" }))
    );
    const store = new FileEstiloBrokerStore(archivo);

    const r = await store.purgeOlderThan(new Date("2026-01-01T00:00:00.000Z"), false);

    expect(r.borrados).toBe(1);
    expect(await readFile(archivo, "utf-8")).toBe("{rota\n" + linea(ejemplo({ texto: "nuevo" })));
  });

  it("si el archivo terminó en media línea, el ejemplo nuevo no se le pega", async () => {
    await writeFile(archivo, linea(ejemplo({ texto: "uno" })) + '{"intent":"cor');
    const store = new FileEstiloBrokerStore(archivo);

    await store.guardar(ejemplo({ texto: "dos" }));

    expect((await store.all()).map((e) => e.texto)).toEqual(["uno", "dos"]);
  });

  // Fechada por posición: la rota hereda la fecha del próximo ejemplo legible.
  // Sin eso no vence nunca y queda para siempre, que es el agujero que el
  // Bloque 37 cerró en el audit log.
  it("una línea rota anterior a un ejemplo vencido también vence", async () => {
    await writeFile(archivo, "{rota\n" + linea(ejemplo({ cuando: "2024-01-01T00:00:00.000Z" })));
    const store = new FileEstiloBrokerStore(archivo);

    const r = await store.purgeOlderThan(new Date("2026-01-01T00:00:00.000Z"), false);

    expect(r.borrados).toBe(2);
    expect(await readFile(archivo, "utf-8")).toBe("");
  });

  // Mismo caso real que en writeJsonFile: el antivirus con el archivo abierto
  // hace fallar el rename. El corpus no se puede reconstruir, así que una
  // reescritura a medias sería definitiva.
  it("si el rename falla al reescribir, el corpus anterior queda intacto", async () => {
    await writeFile(archivo, linea(ejemplo({ texto: "lo de antes" })));
    const store = new FileEstiloBrokerStore(archivo);
    renameFalla = true;

    await expect(store.reescribir([ejemplo({ texto: "lo nuevo" })])).rejects.toThrow("EPERM");
    renameFalla = false;

    expect((await store.all()).map((e) => e.texto)).toEqual(["lo de antes"]);
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("la muestra del purgado va vacía: un ejemplo del corpus ES el texto", async () => {
    await writeFile(archivo, linea(ejemplo({ cuando: "2024-01-01T00:00:00.000Z" })));

    const r = await new FileEstiloBrokerStore(archivo).purgeOlderThan(new Date("2026-01-01T00:00:00.000Z"), false);

    expect(r.muestra).toEqual([]);
  });
});
