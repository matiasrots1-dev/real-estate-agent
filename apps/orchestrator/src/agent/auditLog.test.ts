import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLogEntry } from "shared-types";
import { FileAuditLogStore, InMemoryAuditLogStore, leerAuditLogExistente, parsearAuditLog } from "./auditLog.js";
import { ContactosConocidos } from "./contactosConocidos.js";

function sampleEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: randomUUID(),
    conversationId: "5491100000001",
    timestamp: new Date().toISOString(),
    incomingMessage: "¿el depto de Palermo sigue disponible?",
    matchedIntentId: "consulta_disponibilidad",
    confidence: 0.9,
    toolsCalled: ["tokko.search_properties", "tokko.get_property"],
    escalatedToBroker: false,
    responseSent: "Sigue disponible.",
    ...overrides,
  };
}

describe("InMemoryAuditLogStore", () => {
  it("acumula entries en orden y no expone el array interno", async () => {
    const store = new InMemoryAuditLogStore();
    await store.append(sampleEntry({ id: "a" }));
    await store.append(sampleEntry({ id: "b" }));

    const entries = await store.readAll();
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);

    entries.push(sampleEntry({ id: "c" }));
    expect((await store.readAll()).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("FileAuditLogStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "audit-log-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("devuelve [] si el archivo todavía no existe", async () => {
    const store = new FileAuditLogStore(path.join(dir, "nested", "audit_log.jsonl"));
    expect(await store.readAll()).toEqual([]);
  });

  it("crea el directorio, appendea JSONL, y lo relee en orden", async () => {
    const filePath = path.join(dir, "nested", "audit_log.jsonl");
    const store = new FileAuditLogStore(filePath);

    await store.append(sampleEntry({ id: "a" }));
    await store.append(sampleEntry({ id: "b", escalatedToBroker: true, escalationReason: "test" }));

    const entries = await store.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("a");
    expect(entries[1]).toMatchObject({ id: "b", escalatedToBroker: true, escalationReason: "test" });
  });
});

// docs/TASKS.md Bloque 37. Contra un archivo real, no contra el store en
// memoria: el problema es lo que queda en disco después de un corte.
describe("FileAuditLogStore con una línea rota", () => {
  let dir: string;
  let archivo: string;
  const linea = (e: AuditLogEntry) => `${JSON.stringify(e)}\n`;
  /** Lo que deja un corte a mitad de un appendFile: media línea, sin salto. */
  const MEDIA_LINEA = '{"id":"cortada","conversationId":"54911000000';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "audit-log-rota-"));
    archivo = path.join(dir, "audit_log.jsonl");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("lee las entradas buenas y saltea la rota, en vez de tirar", async () => {
    await writeFile(archivo, linea(sampleEntry({ id: "a" })) + "{esto no es json\n" + linea(sampleEntry({ id: "b" })));

    const entradas = await new FileAuditLogStore(archivo).readAll();

    expect(entradas.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("un JSON válido que no es una entrada también es ilegible", () => {
    const buena = JSON.stringify(sampleEntry({ id: "a" }));
    const { entradas, ilegibles } = parsearAuditLog(
      [
        "null",
        "42",
        "[1]",
        '"texto"',
        '{"id":"sin-fecha-ni-telefono"}',
        '{"id":"x","conversationId":"5491100000001","timestamp":"no es una fecha"}',
        buena,
      ].join("\n")
    );

    expect(entradas.map((e) => e.id)).toEqual(["a"]);
    expect(ilegibles.map((l) => l.numero)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("para los scripts, un archivo que no existe es un error y no una lista vacía", async () => {
    await expect(leerAuditLogExistente(path.join(dir, "no-existe.jsonl"))).rejects.toThrow(/ENOENT/);
  });

  // Lo que tumbaba el arranque: server.ts carga los contactos conocidos del
  // audit log antes de levantar el webhook.
  it("los contactos conocidos se cargan igual", async () => {
    await writeFile(archivo, "{rota\n" + linea(sampleEntry({ conversationId: "5491100000001" })));

    const contactos = new ContactosConocidos();
    await contactos.cargarDesde(new FileAuditLogStore(archivo));

    expect(contactos.conoce("5491100000001")).toBe(true);
  });

  // Modo de fallo 2: tolerar en silencio esconde el problema.
  it("avisa en el log cuántas y en qué línea, sin copiar el contenido", async () => {
    await writeFile(archivo, linea(sampleEntry({ id: "a" })) + "{Hola, soy Juan Pérez\n");

    await new FileAuditLogStore(archivo).readAll();

    expect(console.warn).toHaveBeenCalledTimes(1);
    const aviso = String(vi.mocked(console.warn).mock.calls[0][0]);
    expect(aviso).toContain("1 línea(s) ilegible(s)");
    expect(aviso).toContain("línea 2");
    expect(aviso).not.toContain("Juan");
  });

  it("avisa una vez, no en cada lectura", async () => {
    await writeFile(archivo, "{rota\n");
    const store = new FileAuditLogStore(archivo);

    await store.readAll();
    await store.readAll();
    await store.readAll();

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  // Modo de fallo 1: leer tolerante convertía la purga en un borrado silencioso.
  it("la purga conserva, en su lugar, una línea rota que no venció", async () => {
    const viejo = sampleEntry({ id: "viejo", timestamp: "2025-01-01T00:00:00.000Z" });
    const nuevo = sampleEntry({ id: "nuevo", timestamp: "2026-09-01T00:00:00.000Z" });
    await writeFile(archivo, linea(viejo) + "{rota\n" + linea(nuevo));
    const store = new FileAuditLogStore(archivo);

    const resultado = await store.purgeOlderThan(new Date("2026-01-01T00:00:00.000Z"), false);

    expect(resultado.borrados).toBe(1);
    // La línea rota es anterior a "nuevo", que no venció: se queda, antes que él.
    expect(await readFile(archivo, "utf-8")).toBe("{rota\n" + linea(nuevo));
  });

  // Hallazgo de la revisión del PR: conservarlas para siempre incumplía la
  // retención publicada de 12 meses, con apariencia de cumplida.
  it("la purga borra y cuenta una línea rota que venció: la fecha es la de la entrada siguiente", async () => {
    const viejo1 = sampleEntry({ id: "viejo1", timestamp: "2024-06-01T00:00:00.000Z" });
    const viejo2 = sampleEntry({ id: "viejo2", timestamp: "2025-01-01T00:00:00.000Z" });
    const nuevo = sampleEntry({ id: "nuevo", timestamp: "2026-09-01T00:00:00.000Z" });
    await writeFile(archivo, linea(viejo1) + "{rota-vieja\n" + linea(viejo2) + linea(nuevo));
    const store = new FileAuditLogStore(archivo);

    const resultado = await store.purgeOlderThan(new Date("2026-01-01T00:00:00.000Z"), false);

    expect(resultado.borrados).toBe(3);
    expect(resultado.muestra).toContainEqual({
      store: "audit_log",
      id: "línea ilegible 2",
      fecha: viejo2.timestamp,
    });
    expect(await readFile(archivo, "utf-8")).toBe(linea(nuevo));
  });

  it("una línea rota al final no se borra: es de las más nuevas", async () => {
    const viejo = sampleEntry({ id: "viejo", timestamp: "2025-01-01T00:00:00.000Z" });
    await writeFile(archivo, linea(viejo) + "{rota-al-final\n");
    const store = new FileAuditLogStore(archivo);

    const resultado = await store.purgeOlderThan(new Date("2026-01-01T00:00:00.000Z"), false);

    expect(resultado.borrados).toBe(1);
    expect(await readFile(archivo, "utf-8")).toBe("{rota-al-final\n");
  });

  it("el simulacro cuenta las líneas rotas vencidas pero no toca el archivo", async () => {
    const viejo = sampleEntry({ id: "viejo", timestamp: "2025-01-01T00:00:00.000Z" });
    const contenido = "{rota-vieja\n" + linea(viejo);
    await writeFile(archivo, contenido);

    const resultado = await new FileAuditLogStore(archivo).purgeOlderThan(new Date("2026-01-01T00:00:00.000Z"), true);

    expect(resultado.borrados).toBe(2);
    expect(await readFile(archivo, "utf-8")).toBe(contenido);
  });

  // Hallazgo de la revisión del PR: avisar solo al cambiar la cantidad dejaba
  // el aviso apuntando a líneas que ya no eran las rotas.
  it("vuelve a avisar si cambian las líneas rotas, aunque sean la misma cantidad", async () => {
    const store = new FileAuditLogStore(archivo);
    await writeFile(archivo, "{rota\n" + linea(sampleEntry({ id: "a" })));
    await store.readAll();
    await writeFile(archivo, linea(sampleEntry({ id: "a" })) + "{rota\n");
    await store.readAll();

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.warn).mock.calls[1][0])).toContain("línea 2");
  });

  // Modo de fallo 3: la primera entrada después de un corte se pegaba detrás
  // de la media línea y se perdía con ella.
  it("después de un corte, la primera entrada nueva no se pega a la media línea", async () => {
    await writeFile(archivo, linea(sampleEntry({ id: "a" })) + MEDIA_LINEA);
    const store = new FileAuditLogStore(archivo);

    await store.append(sampleEntry({ id: "despues-del-corte" }));
    await store.append(sampleEntry({ id: "otra" }));

    expect((await store.readAll()).map((e) => e.id)).toEqual(["a", "despues-del-corte", "otra"]);
    // La media línea queda sola, como ilegible, y no se lleva nada con ella.
    const { ilegibles } = parsearAuditLog(await readFile(archivo, "utf-8"));
    expect(ilegibles.map((l) => l.texto)).toEqual([MEDIA_LINEA]);
  });

  // Hallazgo de la revisión del PR: el corte puede pasar con el proceso vivo
  // (disco lleno) o por una edición a mano. Mirar una vez por proceso no alcanza.
  it("si el final se corta con el proceso andando, la escritura siguiente también lo repara", async () => {
    const store = new FileAuditLogStore(archivo);
    await store.append(sampleEntry({ id: "a" }));
    await appendFile(archivo, MEDIA_LINEA);

    await store.append(sampleEntry({ id: "b" }));

    expect((await store.readAll()).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("con escrituras simultáneas después de un corte, ninguna queda pegada a la media línea", async () => {
    await writeFile(archivo, MEDIA_LINEA);
    const store = new FileAuditLogStore(archivo);

    await Promise.all(["uno", "dos", "tres"].map((id) => store.append(sampleEntry({ id }))));

    expect((await store.readAll()).map((e) => e.id).sort()).toEqual(["dos", "tres", "uno"]);
  });

  it("un archivo sano no se toca", async () => {
    await writeFile(archivo, linea(sampleEntry({ id: "a" })));
    const store = new FileAuditLogStore(archivo);

    await store.append(sampleEntry({ id: "b" }));

    const enDisco = await readFile(archivo, "utf-8");
    expect(enDisco.split("\n").filter((l) => l === "")).toHaveLength(1); // solo el salto final
    expect(console.warn).not.toHaveBeenCalled();
  });
});
