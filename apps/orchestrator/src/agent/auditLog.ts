// Auditoría desde el día 1 (CLAUDE.md secc. 3): toda respuesta del agente
// se loguea con intent matcheado, confianza y tools llamadas.
//
// TODO(Bloque 4+): migrar `FileAuditLogStore` a Postgres (ya provisionado
// en docker-compose.yml) cuando el usuario tenga Docker instalado y/o se
// necesite auditoría consultable entre procesos. Hasta entonces, un
// archivo JSONL local alcanza para el POC — ver AuditLogStore, que es la
// interfaz que ambas implementaciones cumplen, así el resto del código no
// depende de cuál esté activa.

import { access, appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditLogEntry } from "shared-types";
import { enmascararTelefono, MUESTRA_MAX, type PurgeResult, type PurgeableStore } from "./purge.js";

export interface AuditLogStore extends PurgeableStore {
  append(entry: AuditLogEntry): Promise<void>;
  readAll(): Promise<AuditLogEntry[]>;
}

const STORE_NAME = "audit_log";

/** Una línea que no se pudo leer (ver `parsearAuditLog` y `purgeOlderThan`). */
export interface LineaIlegible {
  /** Número de línea en el archivo, desde 1. */
  numero: number;
  texto: string;
}

/** Cada línea no vacía del archivo, en orden: la purga necesita el orden. */
type Linea = { entrada: AuditLogEntry; ilegible?: undefined } | { entrada?: undefined; ilegible: LineaIlegible };

function leerLineas(contenido: string): Linea[] {
  const lineas: Linea[] = [];
  contenido.split("\n").forEach((texto, i) => {
    if (texto.trim() === "") return;
    const entrada = comoEntrada(texto);
    lineas.push(entrada ? { entrada } : { ilegible: { numero: i + 1, texto } });
  });
  return lineas;
}

/**
 * Una entrada es un objeto con `conversationId` y un `timestamp` que se
 * pueda fechar. Un JSON válido que no cumple eso (`null`, `{"id":"x"}`)
 * también es ilegible: los lectores harían `entrada.timestamp.localeCompare`
 * sobre él, y sin fecha la retención no lo borraría nunca.
 */
function comoEntrada(texto: string): AuditLogEntry | null {
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch {
    return null;
  }
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) return null;
  const { conversationId, timestamp } = valor as Record<string, unknown>;
  if (typeof conversationId !== "string") return null;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) return null;
  return valor as AuditLogEntry;
}

/**
 * Lee el contenido de un audit log JSONL **sin tirar por una línea rota**
 * (docs/TASKS.md Bloque 37).
 *
 * Un corte a mitad de un `appendFile` deja media línea. Con un `JSON.parse`
 * sin `try`, esa sola línea tumbaba el arranque del bot, y systemd lo
 * reiniciaba en loop. Las líneas ilegibles se devuelven aparte, sin adivinar
 * una reparación: una reparación equivocada es peor que una línea marcada.
 */
export function parsearAuditLog(contenido: string): { entradas: AuditLogEntry[]; ilegibles: LineaIlegible[] } {
  const entradas: AuditLogEntry[] = [];
  const ilegibles: LineaIlegible[] = [];
  for (const linea of leerLineas(contenido)) {
    if (linea.entrada) entradas.push(linea.entrada);
    else ilegibles.push(linea.ilegible);
  }
  return { entradas, ilegibles };
}

/**
 * Para los scripts (`pendientes`, `medir:*`, `etiquetar`). A diferencia de
 * `readAll()`, un archivo que no existe es un error y no una lista vacía: con
 * un symlink roto en el servidor, `pendientes` diría "nadie espera respuesta"
 * en vez de avisar que no encontró el archivo.
 */
export async function leerAuditLogExistente(filePath: string): Promise<AuditLogEntry[]> {
  await access(filePath);
  return new FileAuditLogStore(filePath).readAll();
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
    `Se ignoran al leer y se conservan en el archivo hasta que la retención las alcance: revisarlas a mano.`
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
  /** Las líneas ilegibles del último aviso: se avisa cuando cambian, no en cada lectura. */
  private ultimoAviso = "";

  constructor(private readonly filePath: string) {}

  async append(entry: AuditLogEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // El salto que falta va en la misma escritura que la entrada: así, con
    // escrituras simultáneas, ninguna queda pegada a la media línea.
    const prefijo = await this.saltoQueFalta();
    await appendFile(this.filePath, `${prefijo}${JSON.stringify(entry)}\n`, "utf-8");
  }

  async readAll(): Promise<AuditLogEntry[]> {
    return (await this.leer()).filter((l) => l.entrada).map((l) => l.entrada as AuditLogEntry);
  }

  /**
   * A diferencia del resto de los stores, este archivo es JSONL append-only:
   * purgar obliga a reescribirlo entero. Se escribe a un temporal y se
   * renombra encima (el rename es atómico dentro del mismo filesystem), para
   * que un corte de luz a mitad de la escritura no deje el log truncado o
   * vacío — es irreversible y no hay backup.
   *
   * **Las líneas ilegibles (docs/TASKS.md Bloque 37).** No se pueden descartar
   * al reescribir: la primera purga las borraría sin contarlas (modo de fallo
   * 1). Tampoco se pueden conservar para siempre: son mensajes de clientes, y
   * la política publicada promete borrarlos a los 12 meses. Se fechan por
   * posición: el archivo se escribe en orden, así que una línea rota es
   * anterior a la próxima entrada legible. Si esa entrada ya venció, la línea
   * rota también, y se borra y se cuenta como cualquier otra. Si no hay
   * ninguna entrada después, es de las más nuevas y se queda. Se conservan en
   * su lugar, para que la fecha por posición siga valiendo en la próxima purga.
   */
  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const lineas = await this.leer();
    const corte = cutoff.getTime();

    // La fecha de cada línea: la suya, o la de la próxima entrada legible.
    const fechas: Array<string | undefined> = new Array(lineas.length);
    let siguiente: string | undefined;
    for (let i = lineas.length - 1; i >= 0; i--) {
      const { entrada } = lineas[i];
      if (entrada) siguiente = entrada.timestamp;
      fechas[i] = siguiente;
    }

    const sobreviven: string[] = [];
    const muestra: PurgeResult["muestra"] = [];
    let borrados = 0;
    lineas.forEach((linea, i) => {
      const fecha = fechas[i];
      // Instantes, no strings (ver el bug corregido en el Bloque 14).
      const vencida = fecha !== undefined && new Date(fecha).getTime() < corte;
      if (!vencida) {
        sobreviven.push(linea.entrada ? JSON.stringify(linea.entrada) : linea.ilegible.texto);
        return;
      }
      borrados++;
      if (muestra.length < MUESTRA_MAX) {
        muestra.push(
          linea.entrada
            ? {
                store: STORE_NAME,
                id: linea.entrada.id,
                fecha: linea.entrada.timestamp,
                lead: enmascararTelefono(linea.entrada.conversationId),
              }
            : // Sin id ni teléfono: la línea no se pudo leer. La fecha es la
              // de la entrada siguiente, que es lo que motivó borrarla.
              { store: STORE_NAME, id: `línea ilegible ${linea.ilegible.numero}`, fecha: fecha as string }
        );
      }
    });

    if (!dryRun && borrados > 0) {
      const tmp = `${this.filePath}.tmp`;
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmp, sobreviven.length === 0 ? "" : `${sobreviven.join("\n")}\n`, "utf-8");
      await rename(tmp, this.filePath);
    }
    return { borrados, muestra };
  }

  private async leer(): Promise<Linea[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lineas = leerLineas(content);
    // Tolerar en silencio escondería el problema (modo de fallo 2): el bot
    // seguiría andando con menos historial y nadie sabría por qué. Se avisa
    // cuando cambian las líneas, no la cantidad: después de una purga los
    // números de línea se corren, y el aviso anterior quedaría apuntando mal.
    const ilegibles = lineas.filter((l) => l.ilegible).map((l) => l.ilegible as LineaIlegible);
    const clave = ilegibles.map((l) => l.numero).join(",");
    if (clave !== this.ultimoAviso) {
      this.ultimoAviso = clave;
      if (ilegibles.length > 0) console.warn(describirIlegibles(this.filePath, ilegibles));
    }
    return lineas;
  }

  /**
   * Si una escritura se cortó a mitad (el proceso murió, o el disco se llenó
   * y el proceso siguió), el archivo termina en media línea, sin salto. La
   * entrada siguiente se pegaría detrás y las dos serían una sola línea
   * ilegible: se perdería la entrada buena (modo de fallo 3). Devuelve el
   * salto que hay que anteponer, o nada.
   *
   * Se mira en cada escritura, no una vez por proceso: el corte puede pasar
   * con el proceso vivo (disco lleno), o por una edición a mano. Cuesta leer
   * un byte. Si no se puede mirar, se escribe igual: no poder reparar no
   * puede impedir escribir.
   */
  private async saltoQueFalta(): Promise<string> {
    let archivo;
    try {
      archivo = await open(this.filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[audit] no se pudo revisar el final de ${this.filePath}:`, error);
      }
      return "";
    }
    try {
      const { size } = await archivo.stat();
      if (size === 0) return "";
      const ultimo = Buffer.alloc(1);
      await archivo.read(ultimo, 0, 1, size - 1);
      if (ultimo[0] === 0x0a) return "";
      console.warn(`[audit] ${this.filePath} terminaba en una línea cortada: se agrega el salto que faltaba.`);
      return "\n";
    } catch (error) {
      console.error(`[audit] no se pudo revisar el final de ${this.filePath}:`, error);
      return "";
    } finally {
      await archivo.close();
    }
  }
}
