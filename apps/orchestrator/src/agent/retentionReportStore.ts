import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describirIlegibles, esObjeto, leerLineasJsonl, saltoQueFalta, type LineaJsonl } from "./jsonl.js";
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

/** Un reporte legible tiene, como mínimo, su id y la fecha de la corrida. */
function esReporte(valor: unknown): valor is RetentionReport {
  return esObjeto(valor) && typeof valor.id === "string" && typeof valor.corridaAt === "string";
}

/**
 * JSONL, igual que el audit log. Conserva las últimas `maxCorridas` corridas
 * — suficiente para comparar semana contra semana sin acumular para siempre
 * un archivo con datos personales (aunque sean enmascarados). (Ojo: la
 * retención corre en cada vuelta del scheduler, cada 5 minutos, así que hoy
 * 12 corridas son una hora. Ver docs/TASKS.md Bloque 40.)
 *
 * **Una línea rota no lo frena** (docs/TASKS.md Bloque 39). Antes, `readAll`
 * tiraba: el recorte no se hacía nunca más, el archivo crecía, y el job moría
 * antes de loguear su resumen.
 */
export class FileRetentionReportStore implements RetentionReportStore {
  /** Las líneas ilegibles del último aviso: se avisa cuando cambian, no en cada corrida. */
  private ultimoAviso = "";

  constructor(
    private readonly filePath: string,
    private readonly maxCorridas = 12
  ) {}

  async append(report: RetentionReport): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // El salto que falta va en la misma escritura: si el archivo termina en
    // media línea, este reporte no se pega a ella (modo de fallo 1).
    const prefijo = await saltoQueFalta(this.filePath, ETIQUETA);
    await appendFile(this.filePath, `${prefijo}${JSON.stringify(report)}\n`, "utf-8");

    // El recorte es por posición, como la rotación misma (modo de fallo 3):
    // se conserva todo desde el primer reporte que queda, líneas rotas
    // incluidas. Las rotas anteriores a ese punto son más viejas que lo que se
    // conserva y caen con la rotación, igual que caería un reporte legible.
    const lineas = await this.leer();
    const posiciones = lineas.flatMap((l, i) => (l.valor ? [i] : []));
    if (posiciones.length > this.maxCorridas) {
      const desde = posiciones[posiciones.length - this.maxCorridas];
      const conservar = lineas.slice(desde).map((l) => (l.valor ? JSON.stringify(l.valor) : l.ilegible.texto));
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, `${conservar.join("\n")}\n`, "utf-8");
      await rename(tmp, this.filePath);
    }
  }

  async readAll(): Promise<RetentionReport[]> {
    return (await this.leer()).flatMap((l) => (l.valor ? [l.valor] : []));
  }

  private async leer(): Promise<LineaJsonl<RetentionReport>[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lineas = leerLineasJsonl(content, esReporte);
    // Tolerar en silencio escondería el problema (modo de fallo 2).
    const ilegibles = lineas.flatMap((l) => (l.ilegible ? [l.ilegible] : []));
    const clave = ilegibles.map((l) => l.numero).join(",");
    if (clave !== this.ultimoAviso) {
      this.ultimoAviso = clave;
      if (ilegibles.length > 0) console.warn(describirIlegibles(ETIQUETA, this.filePath, ilegibles));
    }
    return lineas;
  }
}
