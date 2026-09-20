// docs/TASKS.md Bloque 39. Contra un archivo real: el problema es lo que queda
// en disco después de un corte a mitad de una escritura.

import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRetentionReportStore, type RetentionReport, type RetentionReportStore } from "./retentionReportStore.js";
import { InMemoryAuditLogStore } from "./auditLog.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import { InMemoryConversationStateStore } from "./conversationStateStore.js";
import { InMemoryRecontactStateStore } from "./recontactStateStore.js";
import { InMemoryLastInteractionStore } from "./lastInteractionStore.js";
import { createRetentionJob } from "../jobs/retention.js";

const BASE = new Date("2027-08-01T07:00:00.000Z");
/** Una fecha de corrida relativa a `BASE`, para probar el recorte por tiempo. */
const enDias = (dias: number) => new Date(BASE.getTime() + dias * 24 * 60 * 60 * 1000).toISOString();

function reporte(id: string, corridaAt = BASE.toISOString()): RetentionReport {
  return {
    id,
    corridaAt,
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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("FileRetentionReportStore", () => {
  it("devuelve [] si el archivo todavía no existe", async () => {
    expect(await new FileRetentionReportStore(archivo).readAll()).toEqual([]);
  });

  // docs/TASKS.md Bloque 40: se conserva por TIEMPO, no por cantidad. Antes
  // eran las últimas 12 corridas, y con la retención corriendo en cada vuelta
  // del scheduler eso medía 72 minutos en el servidor.
  it("conserva los reportes de los últimos N días y deja caer los más viejos", async () => {
    const store = new FileRetentionReportStore(archivo, 3, () => BASE);

    for (const [id, dias] of [
      ["r1", -10],
      ["r2", -5],
      ["r3", -2],
      ["r4", -1],
      ["r5", 0],
    ] as const) {
      await store.append(reporte(id, enDias(dias)));
    }

    expect((await store.readAll()).map((r) => r.id)).toEqual(["r3", "r4", "r5"]);
  });

  // La cantidad de corridas ya no dice nada: con una por día, 90 reportes son
  // 90 días; con una cada 5 minutos, 90 reportes eran 7 horas y media.
  it("no recorta por cantidad: 20 corridas del mismo día quedan todas", async () => {
    const store = new FileRetentionReportStore(archivo, 3, () => BASE);

    for (let i = 0; i < 20; i += 1) await store.append(reporte(`r${i}`, enDias(0)));

    expect(await store.readAll()).toHaveLength(20);
  });
});

describe("FileRetentionReportStore con una línea rota", () => {
  it("lee los reportes buenos y saltea la línea rota, en vez de tirar", async () => {
    await writeFile(archivo, linea(reporte("r1")) + "{rota\n" + linea(reporte("r2")));

    expect((await new FileRetentionReportStore(archivo).readAll()).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("un JSON válido que no es un reporte también es ilegible", async () => {
    await writeFile(
      archivo,
      [
        "null",
        "[1]",
        '{"id":"sin-fecha"}',
        // Completa salvo la fecha: solo la fecha la hace ilegible.
        JSON.stringify({ ...reporte("fecha-vacia"), corridaAt: "" }),
        '{"id":"sin-muestra","corridaAt":"2027-08-01T07:00:00.000Z","totalBorrados":0,"borradosPorStore":{}}',
      ].join("\n") +
        "\n" +
        linea(reporte("r1"))
    );

    expect((await new FileRetentionReportStore(archivo).readAll()).map((r) => r.id)).toEqual(["r1"]);
  });

  // Modo de fallo 2: antes, append tiraba y el recorte no se hacía nunca más.
  it("append no tira y sigue recortando aunque haya una línea rota", async () => {
    await writeFile(
      archivo,
      linea(reporte("r1", enDias(-10))) +
        "{rota\n" +
        linea(reporte("r2", enDias(-5))) +
        linea(reporte("r3", enDias(-2)))
    );
    const store = new FileRetentionReportStore(archivo, 3, () => BASE);

    await store.append(reporte("r4", enDias(0)));

    expect((await store.readAll()).map((r) => r.id)).toEqual(["r3", "r4"]);
  });

  // Modo de fallo 3: el recorte es por posición, como la rotación. Una línea
  // rota no tiene fecha, así que no puede definir el corte — lo definen los
  // reportes que sí se leen, y ella queda o cae según dónde esté.
  it("el recorte conserva la línea rota que quedó dentro de la ventana", async () => {
    await writeFile(
      archivo,
      linea(reporte("r1", enDias(-10))) + linea(reporte("r2", enDias(-2))) + "{rota-reciente\n"
    );
    const store = new FileRetentionReportStore(archivo, 3, () => BASE);

    await store.append(reporte("r3", enDias(0)));

    expect(await readFile(archivo, "utf-8")).toBe(
      linea(reporte("r2", enDias(-2))) + "{rota-reciente\n" + linea(reporte("r3", enDias(0)))
    );
  });

  it("y deja caer, con la rotación, la línea rota anterior a lo que se conserva", async () => {
    await writeFile(
      archivo,
      "{rota-vieja\n" + linea(reporte("r1", enDias(-10))) + linea(reporte("r2", enDias(-2)))
    );
    const store = new FileRetentionReportStore(archivo, 3, () => BASE);

    await store.append(reporte("r3", enDias(0)));

    expect(await readFile(archivo, "utf-8")).toBe(
      linea(reporte("r2", enDias(-2))) + linea(reporte("r3", enDias(0)))
    );
  });

  // El reporte recién escrito siempre está dentro de la ventana, así que esto
  // sólo pasa si el reloj de la máquina salta hacia atrás. Preferimos un
  // archivo de más antes que borrar el único rastro de un borrado.
  it("si ningún reporte entra en la ventana, no recorta nada", async () => {
    await writeFile(archivo, linea(reporte("r1", enDias(-100))) + linea(reporte("r2", enDias(-99))));
    const store = new FileRetentionReportStore(archivo, 3, () => BASE);

    await store.append(reporte("r3", enDias(-98)));

    expect((await store.readAll()).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
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

  // Hallazgo de la revisión del PR: el aviso salía con números de antes del
  // recorte, que ya no apuntaban a la línea rota.
  it("después de un recorte avisa de nuevo, con los números del archivo recortado", async () => {
    await writeFile(archivo, linea(reporte("r1", enDias(-2))) + linea(reporte("r2", enDias(-1))) + "{rota\n");
    let ahora = BASE;
    const store = new FileRetentionReportStore(archivo, 3, () => ahora);

    await store.append(reporte("r3", enDias(0))); // todo entra: no recorta, la rota es la línea 3
    ahora = new Date(BASE.getTime() + 2 * 24 * 60 * 60 * 1000);
    await store.append(reporte("r4", enDias(2))); // r1 se cae: la rota pasa a la línea 2

    // El segundo aviso sale en el mismo append que recorta, no en el siguiente.
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain("línea 3");
    expect(String(vi.mocked(console.warn).mock.calls[1][0])).toContain("línea 2");

    await store.append(reporte("r5", enDias(2))); // no recorta: nada nuevo que avisar
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  // Hallazgo de la revisión del PR: el reporte ya está escrito cuando se
  // recorta; un error del recorte no puede hacer fallar la corrida.
  it("si el recorte falla, append no tira y el reporte queda escrito", async () => {
    class ConRecorteQueFalla extends FileRetentionReportStore {
      protected override async recortar(): Promise<void> {
        throw new Error("EPERM: el antivirus tiene el archivo abierto");
      }
    }
    const store = new ConRecorteQueFalla(archivo);

    await expect(store.append(reporte("r1"))).resolves.toBeUndefined();

    expect((await store.readAll()).map((r) => r.id)).toEqual(["r1"]);
    expect(console.error).toHaveBeenCalled();
  });

  // Hallazgo de la revisión del PR: el scheduler no espera a que termine la
  // vuelta anterior, y dos recortes superpuestos se pisaban (con un temporal
  // de nombre fijo, uno le renombraba el temporal al otro; en Windows, el
  // rename falla si el otro tiene el archivo abierto).
  it("appends simultáneos van de a uno: ninguno falla ni se pierde", async () => {
    const store = new FileRetentionReportStore(archivo, 3, () => BASE);
    const corridas: Array<[string, number]> = [
      ["a", -10],
      ["b", -9],
      ["c", -8],
      ["d", -7],
      ["e", -2],
      ["f", -1],
      ["g", 0],
    ];

    await Promise.all(corridas.map(([id, dias]) => store.append(reporte(id, enDias(dias)))));

    expect(console.error).not.toHaveBeenCalled();
    // Los cuatro viejos se recortaron en el camino, y los tres de la ventana
    // quedaron en orden.
    expect((await store.readAll()).map((r) => r.id)).toEqual(["e", "f", "g"]);
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("si una escritura falla, las siguientes siguen", async () => {
    class ConPrimeraEscrituraQueFalla extends FileRetentionReportStore {
      private fallo = false;
      protected override async escribir(report: RetentionReport): Promise<void> {
        if (!this.fallo) {
          this.fallo = true;
          throw new Error("ENOSPC");
        }
        return super.escribir(report);
      }
    }
    const store = new ConPrimeraEscrituraQueFalla(archivo);

    const resultados = await Promise.allSettled(["a", "b"].map((id) => store.append(reporte(id))));

    expect(resultados.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    expect((await store.readAll()).map((r) => r.id)).toEqual(["b"]);
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
      horaDeCorrida: 4,
      now: () => new Date("2027-08-01T07:00:00.000Z"),
    });

    await expect(job.run()).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("jobs/retention [BORRADO REAL]"));
  });

  // Hallazgo de la revisión del PR: la línea rota era solo una de las causas.
  // Con el disco lleno, guardar el reporte falla por otra, y el resumen del
  // journal se perdía igual.
  it("si guardar el reporte falla por cualquier causa, el resumen sale igual", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const reportStore: RetentionReportStore = {
      append: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
      readAll: async () => [],
    };
    const job = createRetentionJob({
      auditLog: new InMemoryAuditLogStore(),
      conversationStateStore: new InMemoryConversationStateStore(),
      appointmentStore: new InMemoryAppointmentStore(),
      recontactStateStore: new InMemoryRecontactStateStore(),
      lastInteractionStore: new InMemoryLastInteractionStore(),
      reportStore,
      mesesMensajes: 12,
      mesesGestionComercial: 24,
      borradoHabilitado: true,
      horaDeCorrida: 4,
      now: () => new Date("2027-08-01T07:00:00.000Z"),
    });

    await expect(job.run()).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("jobs/retention [BORRADO REAL]"));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("no se pudo guardar el reporte"),
      expect.anything()
    );
  });
});
