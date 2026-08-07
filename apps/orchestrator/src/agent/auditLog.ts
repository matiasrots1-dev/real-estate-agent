// Auditoría desde el día 1 (CLAUDE.md secc. 3): toda respuesta del agente
// se loguea con intent matcheado, confianza y tools llamadas.
//
// TODO(Bloque 4+): migrar `FileAuditLogStore` a Postgres (ya provisionado
// en docker-compose.yml) cuando el usuario tenga Docker instalado y/o se
// necesite auditoría consultable entre procesos. Hasta entonces, un
// archivo JSONL local alcanza para el POC — ver AuditLogStore, que es la
// interfaz que ambas implementaciones cumplen, así el resto del código no
// depende de cuál esté activa.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditLogEntry } from "shared-types";
import { enmascararTelefono, MUESTRA_MAX, type PurgeResult, type PurgeableStore } from "./purge.js";

export interface AuditLogStore extends PurgeableStore {
  append(entry: AuditLogEntry): Promise<void>;
  readAll(): Promise<AuditLogEntry[]>;
}

const STORE_NAME = "audit_log";

function particionar(entries: AuditLogEntry[], cutoff: Date) {
  const corte = cutoff.getTime();
  const sobreviven: AuditLogEntry[] = [];
  const muestra: PurgeResult["muestra"] = [];
  let borrados = 0;

  for (const entry of entries) {
    // Instantes, no strings (ver el bug corregido en el Bloque 14).
    if (new Date(entry.timestamp).getTime() < corte) {
      borrados++;
      if (muestra.length < MUESTRA_MAX) {
        muestra.push({
          store: STORE_NAME,
          id: entry.id,
          fecha: entry.timestamp,
          lead: enmascararTelefono(entry.conversationId),
        });
      }
    } else {
      sobreviven.push(entry);
    }
  }

  return { result: { borrados, muestra }, sobreviven };
}

export class InMemoryAuditLogStore implements AuditLogStore {
  private readonly entries: AuditLogEntry[] = [];

  async append(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  async readAll(): Promise<AuditLogEntry[]> {
    return [...this.entries];
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, sobreviven } = particionar(this.entries, cutoff);
    if (!dryRun) {
      this.entries.length = 0;
      this.entries.push(...sobreviven);
    }
    return result;
  }
}

export class FileAuditLogStore implements AuditLogStore {
  constructor(private readonly filePath: string) {}

  async append(entry: AuditLogEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  async readAll(): Promise<AuditLogEntry[]> {
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
      .map((line) => JSON.parse(line) as AuditLogEntry);
  }

  /**
   * A diferencia del resto de los stores, este archivo es JSONL append-only:
   * purgar obliga a reescribirlo entero. Se escribe a un temporal y se
   * renombra encima (el rename es atómico dentro del mismo filesystem), para
   * que un corte de luz a mitad de la escritura no deje el log truncado o
   * vacío — es irreversible y no hay backup.
   */
  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, sobreviven } = particionar(await this.readAll(), cutoff);
    if (!dryRun && result.borrados > 0) {
      const tmp = `${this.filePath}.tmp`;
      const contenido = sobreviven.map((e) => JSON.stringify(e)).join("\n");
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmp, contenido === "" ? "" : `${contenido}\n`, "utf-8");
      await rename(tmp, this.filePath);
    }
    return result;
  }
}
