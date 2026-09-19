// Auditoría desde el día 1 (CLAUDE.md secc. 3): toda respuesta del agente
// se loguea con intent matcheado, confianza y tools llamadas.
//
// TODO(Bloque 4+): migrar `FileAuditLogStore` a Postgres (ya provisionado
// en docker-compose.yml) cuando el usuario tenga Docker instalado y/o se
// necesite auditoría consultable entre procesos. Hasta entonces, un
// archivo JSONL local alcanza para el POC — ver AuditLogStore, que es la
// interfaz que ambas implementaciones cumplen, así el resto del código no
// depende de cuál esté activa.

import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditLogEntry } from "shared-types";
import { enmascararTelefono, MUESTRA_MAX, type PurgeResult, type PurgeableStore } from "./purge.js";

export interface AuditLogStore extends PurgeableStore {
  append(entry: AuditLogEntry): Promise<void>;
  readAll(): Promise<AuditLogEntry[]>;
}

const STORE_NAME = "audit_log";

/** Una línea que no se pudo leer. Se conserva tal cual (ver `purgeOlderThan`). */
export interface LineaIlegible {
  /** Número de línea en el archivo, desde 1. */
  numero: number;
  texto: string;
}

/**
 * Lee el contenido de un audit log JSONL **sin tirar por una línea rota**
 * (docs/TASKS.md Bloque 37).
 *
 * Un corte a mitad de un `appendFile` deja media línea. Con un `JSON.parse`
 * sin `try`, esa sola línea tumbaba el arranque del bot, y systemd lo
 * reiniciaba en loop. Las líneas ilegibles se devuelven aparte, sin adivinar
 * una reparación: una reparación equivocada es peor que una línea marcada.
 *
 * Una línea que es JSON válido pero no un objeto (`null`, un número) también
 * es ilegible: los lectores harían `entrada.conversationId` sobre ella.
 *
 * La usan el store y los scripts que leen el archivo directo (`pendientes`,
 * `medir:*`, `etiquetar`).
 */
export function parsearAuditLog(contenido: string): { entradas: AuditLogEntry[]; ilegibles: LineaIlegible[] } {
  const entradas: AuditLogEntry[] = [];
  const ilegibles: LineaIlegible[] = [];
  contenido.split("\n").forEach((linea, i) => {
    if (linea.trim() === "") return;
    try {
      const valor: unknown = JSON.parse(linea);
      if (typeof valor === "object" && valor !== null && !Array.isArray(valor)) {
        entradas.push(valor as AuditLogEntry);
        return;
      }
    } catch {
      // Cae abajo: se marca como ilegible.
    }
    ilegibles.push({ numero: i + 1, texto: linea });
  });
  return { entradas, ilegibles };
}

/**
 * El aviso de líneas ilegibles, **sin el contenido**: son mensajes de
 * clientes, y el log del servidor no es lugar para copiarlos.
 */
export function describirIlegibles(archivo: string, ilegibles: readonly LineaIlegible[]): string {
  const numeros = ilegibles.slice(0, 10).map((l) => l.numero).join(", ");
  const resto = ilegibles.length > 10 ? ` y ${ilegibles.length - 10} más` : "";
  return (
    `[audit] ${ilegibles.length} línea(s) ilegible(s) en ${archivo} (línea ${numeros}${resto}). ` +
    `Se ignoran al leer y se conservan en el archivo: revisarlas a mano.`
  );
}

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
  /** Cuántas ilegibles se avisaron la última vez: se avisa al cambiar, no en cada lectura. */
  private ilegiblesAvisadas = 0;
  /** La reparación del final del archivo, una vez por proceso (ver `terminarLineaCortada`). */
  private listoParaEscribir: Promise<void> | null = null;

  constructor(private readonly filePath: string) {}

  async append(entry: AuditLogEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.listoParaEscribir ??= this.terminarLineaCortada();
    await this.listoParaEscribir;
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  async readAll(): Promise<AuditLogEntry[]> {
    return (await this.leer()).entradas;
  }

  /**
   * A diferencia del resto de los stores, este archivo es JSONL append-only:
   * purgar obliga a reescribirlo entero. Se escribe a un temporal y se
   * renombra encima (el rename es atómico dentro del mismo filesystem), para
   * que un corte de luz a mitad de la escritura no deje el log truncado o
   * vacío — es irreversible y no hay backup.
   *
   * Las líneas ilegibles se reescriben tal cual, al final (docs/TASKS.md
   * Bloque 37, modo de fallo 1). Sin eso, la primera purga que borrara algo
   * las eliminaría sin contarlas, y borrar datos es decisión del dueño del
   * repo, no un efecto secundario de leer. No tienen fecha legible, así que la
   * retención no puede decidir sobre ellas: quedan para revisar a mano.
   */
  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { entradas, ilegibles } = await this.leer();
    const { result, sobreviven } = particionar(entradas, cutoff);
    if (!dryRun && result.borrados > 0) {
      const tmp = `${this.filePath}.tmp`;
      const lineas = [...sobreviven.map((e) => JSON.stringify(e)), ...ilegibles.map((l) => l.texto)];
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmp, lineas.length === 0 ? "" : `${lineas.join("\n")}\n`, "utf-8");
      await rename(tmp, this.filePath);
    }
    return result;
  }

  private async leer(): Promise<{ entradas: AuditLogEntry[]; ilegibles: LineaIlegible[] }> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entradas: [], ilegibles: [] };
      throw error;
    }
    const leido = parsearAuditLog(content);
    // Tolerar en silencio escondería el problema (modo de fallo 2): el bot
    // seguiría andando con menos historial y nadie sabría por qué.
    if (leido.ilegibles.length !== this.ilegiblesAvisadas) {
      this.ilegiblesAvisadas = leido.ilegibles.length;
      if (leido.ilegibles.length > 0) console.warn(describirIlegibles(this.filePath, leido.ilegibles));
    }
    return leido;
  }

  /**
   * Si el proceso anterior murió a mitad de un `appendFile`, el archivo
   * termina en media línea, sin salto. La primera entrada nueva se pegaría
   * detrás y las dos serían una sola línea ilegible: se perdería justo la
   * primera entrada después del reinicio (modo de fallo 3). Se agrega el salto
   * que falta antes de escribir.
   *
   * Alcanza con una vez por proceso: las escrituras de este proceso siempre
   * terminan en salto. Todas las escrituras esperan esta misma promesa, así
   * que ninguna se adelanta a la reparación. Si falla, se sigue: no poder
   * reparar no puede impedir escribir.
   */
  private async terminarLineaCortada(): Promise<void> {
    try {
      const archivo = await open(this.filePath, "r");
      try {
        const { size } = await archivo.stat();
        if (size === 0) return;
        const ultimo = Buffer.alloc(1);
        await archivo.read(ultimo, 0, 1, size - 1);
        if (ultimo.toString("utf-8") === "\n") return;
      } finally {
        await archivo.close();
      }
      await appendFile(this.filePath, "\n", "utf-8");
      console.warn(`[audit] ${this.filePath} terminaba en una línea cortada: se agregó el salto que faltaba.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      console.error(`[audit] no se pudo revisar el final de ${this.filePath}:`, error);
    }
  }
}
