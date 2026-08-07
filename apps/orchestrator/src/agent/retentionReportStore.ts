import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
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

/**
 * JSONL, igual que el audit log. Conserva las últimas `maxCorridas` corridas
 * — suficiente para comparar semana contra semana sin acumular para siempre
 * un archivo con datos personales (aunque sean enmascarados).
 */
export class FileRetentionReportStore implements RetentionReportStore {
  constructor(
    private readonly filePath: string,
    private readonly maxCorridas = 12
  ) {}

  async append(report: RetentionReport): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(report)}\n`, "utf-8");

    const todos = await this.readAll();
    if (todos.length > this.maxCorridas) {
      const conservar = todos.slice(-this.maxCorridas);
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, `${conservar.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
      await rename(tmp, this.filePath);
    }
  }

  async readAll(): Promise<RetentionReport[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RetentionReport);
  }
}
