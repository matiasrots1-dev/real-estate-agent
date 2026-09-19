import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AvisoDeIlegibles, esObjeto, ilegiblesDe, leerArchivoJsonl, leerLineasJsonl, saltoQueFalta } from "./jsonl.js";
import type { PurgedRecord } from "./purge.js";

/**
 * Reporte de cada corrida del purgado (docs/TASKS.md Bloque 15). Persistido
 * a propósito y no solo impreso en consola: el dueño del repo necesita poder
 * comparar la corrida de esta semana con la de la anterior para validar que
 * el criterio está bien aplicado antes de habilitar el borrado real.
 *
 * **El reporte NO lleva contenido de mensajes.** Si lo llevara, este archivo
 * se convertiría en un almacén persistente de exactamente los datos
 * personales que el purgado existe para borrar — empeorando el problema en
 * vez de resolverlo. Con la fecha que motivó cada decisión, el registro
 * identificado y el teléfono enmascarado alcanza para juzgar el criterio.
 */
export interface RetentionReport {
  id: string;
  corridaAt: string;
  /** `true` = simulacro, no se borró nada. */
  dryRun: boolean;
  cutoffMensajes: string;
  cutoffGestionComercial: string;
  leadsVencidos: number;
  borradosPorStore: Record<string, number>;
  totalBorrados: number;
  /** Muestra acotada de qué registros cayeron, para poder auditar el criterio. */
  muestra: PurgedRecord[];
}

export interface RetentionReportStore {
  append(report: RetentionReport): Promise<void>;
  readAll(): Promise<RetentionReport[]>;
}

export class InMemoryRetentionReportStore implements RetentionReportStore {
  private readonly reports: RetentionReport[] = [];

  async append(report: RetentionReport): Promise<void> {
    this.reports.push(report);
  }

  async readAll(): Promise<RetentionReport[]> {
    return [...this.reports];
  }
}

const ETIQUETA = "retention";

/**
 * Un reporte legible: los campos que un lector del reporte recorre. Sin esta
 * validación, `{"id":"x"}` ocuparía uno de los lugares que se conservan y
 * saldría de `readAll()` tipado como reporte completo.
 */
function esReporte(valor: unknown): valor is RetentionReport {
  return (
    esObjeto(valor) &&
    typeof valor.id === "string" &&
    typeof valor.corridaAt === "string" &&
    !Number.isNaN(Date.parse(valor.corridaAt)) &&
    typeof valor.totalBorrados === "number" &&
    esObjeto(valor.borradosPorStore) &&
    Array.isArray(valor.muestra)
  );
}

/**
 * JSONL, igual que el audit log. Conserva las últimas corridas — suficiente
 * para comparar sin acumular para siempre un archivo con datos personales
 * (aunque sean enmascarados). Recorta recién cuando pasa el doble de
 * `maxCorridas`, y deja las últimas `maxCorridas`: recortar en cada corrida
 * reescribiría el archivo entero cada 5 minutos para agregar una línea.
 * (Ojo: la retención corre en cada vuelta del scheduler, así que hoy 12
 * corridas son una hora. Ver docs/TASKS.md Bloque 40.)
 *
 * **Una línea rota no lo frena** (docs/TASKS.md Bloque 39). Antes, `readAll`
 * tiraba: el recorte no se hacía nunca más, el archivo crecía, y el job moría
 * antes de loguear su resumen.
 */
export class FileRetentionReportStore implements RetentionReportStore {
  private readonly aviso: AvisoDeIlegibles;

  constructor(
    private readonly filePath: string,
    private readonly maxCorridas = 12
  ) {
    this.aviso = new AvisoDeIlegibles(ETIQUETA, filePath);
  }

  /**
   * Las escrituras de este store van de a una. El scheduler no espera a que
   * termine la vuelta anterior, así que una corrida lenta puede superponerse
   * con la siguiente, y sus recortes (leer, filtrar, renombrar) se pisarían:
   * un reporte escrito entre la lectura de uno y el rename del otro se
   * perdería. Un fallo no corta la cola para las siguientes.
   */
  private cola: Promise<void> = Promise.resolve();

  append(report: RetentionReport): Promise<void> {
    const turno = this.cola.then(() => this.escribir(report));
    this.cola = turno.catch(() => {});
    return turno;
  }

  /** `protected` para que los tests puedan hacerla fallar. */
  protected async escribir(report: RetentionReport): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // El salto que falta va en la misma escritura: si el archivo termina en
    // media línea, este reporte no se pega a ella (modo de fallo 1).
    const prefijo = await saltoQueFalta(this.filePath, ETIQUETA);
    await appendFile(this.filePath, `${prefijo}${JSON.stringify(report)}\n`, "utf-8");

    // El reporte ya quedó escrito. El recorte es mantenimiento: si falla, se
    // avisa y se sigue, sin hacer fallar la corrida.
    try {
      await this.recortar();
    } catch (error) {
      console.error(`[${ETIQUETA}] no se pudo recortar ${this.filePath}:`, error);
    }
  }

  async readAll(): Promise<RetentionReport[]> {
    const lineas = await leerArchivoJsonl(this.filePath, esReporte);
    this.aviso.avisar(ilegiblesDe(lineas));
    return lineas.flatMap((l) => (l.valor ? [l.valor] : []));
  }

  /**
   * Por posición, como la rotación misma (modo de fallo 3): se conserva todo
   * desde el primer reporte que queda, líneas rotas incluidas. Las rotas
   * anteriores a ese punto son más viejas que lo que se conserva y caen con
   * la rotación, igual que caería un reporte legible.
   *
   * `protected` para que los tests puedan hacerlo fallar.
   */
  protected async recortar(): Promise<void> {
    const lineas = await leerArchivoJsonl(this.filePath, esReporte);
    const posiciones = lineas.flatMap((l, i) => (l.valor ? [i] : []));
    if (posiciones.length <= 2 * this.maxCorridas) {
      this.aviso.avisar(ilegiblesDe(lineas));
      return;
    }

    const desde = posiciones[posiciones.length - this.maxCorridas];
    const contenido = `${lineas
      .slice(desde)
      .map((l) => (l.valor ? JSON.stringify(l.valor) : l.ilegible.texto))
      .join("\n")}\n`;
    // Temporal con nombre propio: la cola ordena las escrituras de este
    // proceso, pero no las de otro (un script corriendo a mano en el servidor).
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, contenido, "utf-8");
      await rename(tmp, this.filePath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    // El aviso con los números del archivo ya recortado, que son los que
    // alguien va a buscar.
    this.aviso.avisar(ilegiblesDe(leerLineasJsonl(contenido, esReporte)));
  }
}
