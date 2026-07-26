// Auditoría desde el día 1 (CLAUDE.md secc. 3): toda respuesta del agente
// se loguea con intent matcheado, confianza y tools llamadas.
//
// TODO(Bloque 4+): migrar `FileAuditLogStore` a Postgres (ya provisionado
// en docker-compose.yml) cuando el usuario tenga Docker instalado y/o se
// necesite auditoría consultable entre procesos. Hasta entonces, un
// archivo JSONL local alcanza para el POC — ver AuditLogStore, que es la
// interfaz que ambas implementaciones cumplen, así el resto del código no
// depende de cuál esté activa.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AuditLogEntry } from "shared-types";

export interface AuditLogStore {
  append(entry: AuditLogEntry): Promise<void>;
  readAll(): Promise<AuditLogEntry[]>;
}

export class InMemoryAuditLogStore implements AuditLogStore {
  private readonly entries: AuditLogEntry[] = [];

  async append(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  async readAll(): Promise<AuditLogEntry[]> {
    return [...this.entries];
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
}
