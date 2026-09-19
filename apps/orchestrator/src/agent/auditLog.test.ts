import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLogEntry } from "shared-types";
import { FileAuditLogStore, InMemoryAuditLogStore, parsearAuditLog } from "./auditLog.js";
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

  it("un JSON válido que no es un objeto también es ilegible", () => {
    const { entradas, ilegibles } = parsearAuditLog('null\n42\n[1]\n"texto"\n{"id":"a"}\n');

    expect(entradas.map((e) => e.id)).toEqual(["a"]);
    expect(ilegibles.map((l) => l.numero)).toEqual([1, 2, 3, 4]);
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
  it("la purga borra lo viejo pero conserva la línea rota tal cual", async () => {
    const viejo = sampleEntry({ id: "viejo", timestamp: "2025-01-01T00:00:00.000Z" });
    const nuevo = sampleEntry({ id: "nuevo", timestamp: "2026-09-01T00:00:00.000Z" });
    await writeFile(archivo, linea(viejo) + "{rota\n" + linea(nuevo));
    const store = new FileAuditLogStore(archivo);

    const resultado = await store.purgeOlderThan(new Date("2026-01-01T00:00:00.000Z"), false);

    expect(resultado.borrados).toBe(1);
    const enDisco = await readFile(archivo, "utf-8");
    expect(enDisco).toContain("{rota");
    expect(enDisco).not.toContain('"viejo"');
    expect((await store.readAll()).map((e) => e.id)).toEqual(["nuevo"]);
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

  it("con escrituras simultáneas después de un corte, ninguna se adelanta a la reparación", async () => {
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
