// docs/TASKS.md Bloque 39. Contra un archivo real: el problema es lo que queda
// en disco después de un corte a mitad de una escritura.

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRetentionReportStore, type RetentionReport } from "./retentionReportStore.js";
import { InMemoryAuditLogStore } from "./auditLog.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore } from "./conversationStateStore.js";
import { InMemoryRecontactStateStore } from "./recontactStateStore.js";
import { InMemoryLastInteractionStore } from "./lastInteractionStore.js";
import { createRetentionJob } from "../jobs/retention.js";

function reporte(id: string): RetentionReport {
  return {
    id,
    corridaAt: "2027-08-01T07:00:00.000Z",
    dryRun: false,
    cutoffMensajes: "2026-08-01T07:00:00.000Z",
    cutoffGestionComercial: "2025-08-01T07:00:00.000Z",
    leadsVencidos: 0,
    borradosPorStore: { audit_log: 3 },
    totalBorrados: 3,
    muestra: [],
  };
}

const linea = (r: RetentionReport) => `${JSON.stringify(r)}\n`;
/** Lo que deja un corte a mitad de un appendFile: media línea, sin salto. */
const MEDIA_LINEA = '{"id":"cortado","corridaAt":"2027-08-01T0';

let dir: string;
let archivo: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "reporte-retencion-"));
  archivo = path.join(dir, "retention_reports.jsonl");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("FileRetentionReportStore", () => {
  it("devuelve [] si el archivo todavía no existe", async () => {
    expect(await new FileRetentionReportStore(archivo).readAll()).toEqual([]);
  });

  it("conserva las últimas N corridas", async () => {
    const store = new FileRetentionReportStore(archivo, 3);
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) await store.append(reporte(id));

    expect((await store.readAll()).map((r) => r.id)).toEqual(["r3", "r4", "r5"]);
  });
});

describe("FileRetentionReportStore con una línea rota", () => {
  it("lee los reportes buenos y saltea la línea rota, en vez de tirar", async () => {
    await writeFile(archivo, linea(reporte("r1")) + "{rota\n" + linea(reporte("r2")));

    expect((await new FileRetentionReportStore(archivo).readAll()).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("un JSON válido que no es un reporte también es ilegible", async () => {
    await writeFile(archivo, 'null\n[1]\n{"id":"sin-fecha"}\n' + linea(reporte("r1")));

    expect((await new FileRetentionReportStore(archivo).readAll()).map((r) => r.id)).toEqual(["r1"]);
  });

  // Modo de fallo 2: antes, append tiraba y el recorte no se hacía nunca más.
  it("append no tira y sigue recortando aunque haya una línea rota", async () => {
    await writeFile(archivo, linea(reporte("r1")) + "{rota\n" + linea(reporte("r2")) + linea(reporte("r3")));
    const store = new FileRetentionReportStore(archivo, 2);

    await store.append(reporte("r4"));

    expect((await store.readAll()).map((r) => r.id)).toEqual(["r3", "r4"]);
  });

  // Modo de fallo 3: el recorte es por posición, como la rotación.
  it("el recorte conserva la línea rota que quedó dentro de las últimas N corridas", async () => {
    await writeFile(archivo, linea(reporte("r1")) + linea(reporte("r2")) + linea(reporte("r3")) + "{rota-reciente\n");
    const store = new FileRetentionReportStore(archivo, 2);

    await store.append(reporte("r4"));

    // Quedan r3 y r4, y la línea rota que está entre los dos.
    expect(await readFile(archivo, "utf-8")).toBe(linea(reporte("r3")) + "{rota-reciente\n" + linea(reporte("r4")));
  });

  it("y deja caer, con la rotación, la línea rota anterior a lo que se conserva", async () => {
    await writeFile(archivo, "{rota-vieja\n" + linea(reporte("r1")) + linea(reporte("r2")) + linea(reporte("r3")));
    const store = new FileRetentionReportStore(archivo, 2);

    await store.append(reporte("r4"));

    expect(await readFile(archivo, "utf-8")).toBe(linea(reporte("r3")) + linea(reporte("r4")));
  });

  // Modo de fallo 1: el reporte siguiente se pegaba a la media línea y se perdía.
  it("después de un corte, el reporte nuevo no se pega a la media línea", async () => {
    await writeFile(archivo, linea(reporte("r1")) + MEDIA_LINEA);
    const store = new FileRetentionReportStore(archivo);

    await store.append(reporte("despues-del-corte"));

    expect((await store.readAll()).map((r) => r.id)).toEqual(["r1", "despues-del-corte"]);
  });

  it("también si el corte pasa con el proceso andando", async () => {
    const store = new FileRetentionReportStore(archivo);
    await store.append(reporte("r1"));
    await appendFile(archivo, MEDIA_LINEA);

    await store.append(reporte("r2"));

    expect((await store.readAll()).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("avisa en el log una vez, no en cada corrida", async () => {
    await writeFile(archivo, "{rota\n");
    const store = new FileRetentionReportStore(archivo);

    await store.readAll();
    await store.readAll();
    await store.append(reporte("r1"));

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain("línea 1");
  });

  it("un archivo sano no se toca ni avisa", async () => {
    await writeFile(archivo, linea(reporte("r1")));
    const store = new FileRetentionReportStore(archivo);

    await store.append(reporte("r2"));

    expect(await readFile(archivo, "utf-8")).toBe(linea(reporte("r1")) + linea(reporte("r2")));
    expect(console.warn).not.toHaveBeenCalled();
  });
});

// El job completo: antes, con una línea rota, moría antes de loguear su
// resumen, y esa línea del journal es hoy el único rastro duradero de un borrado.
describe("el job de retención con una línea rota en el reporte", () => {
  it("termina y loguea el resumen", async () => {
    await writeFile(archivo, "{rota\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = createRetentionJob({
      auditLog: new InMemoryAuditLogStore(),
      conversationStateStore: new InMemoryConversationStateStore(),
      appointmentStore: new InMemoryAppointmentStore(),
      recontactStateStore: new InMemoryRecontactStateStore(),
      lastInteractionStore: new InMemoryLastInteractionStore(),
      reportStore: new FileRetentionReportStore(archivo),
      mesesMensajes: 12,
      mesesGestionComercial: 24,
      borradoHabilitado: true,
      now: () => new Date("2027-08-01T07:00:00.000Z"),
    });

    await expect(job.run()).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("jobs/retention [BORRADO REAL]"));
  });
});
