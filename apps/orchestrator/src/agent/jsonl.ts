import { open, readFile } from "node:fs/promises";

/**
 * Lectura y escritura tolerantes de archivos JSONL (docs/TASKS.md Bloques 37
 * y 39).
 *
 * Un corte a mitad de un `appendFile` deja media línea. Leer con `JSON.parse`
 * sin `try` convierte esa media línea en un error permanente del store
 * entero, y escribir detrás de ella pega la entrada siguiente a la media
 * línea: se pierden las dos.
 *
 * Hoy lo usa solo el reporte de retención. El audit log tiene su propia
 * versión (Bloque 37) y no se migró a propósito, para no mezclar dos cambios
 * en el mismo camino. El corpus de estilo, cuando se arregle, debería usar
 * este módulo.
 */

/** Una línea que no se pudo leer. */
export interface LineaIlegible {
  /** Número de línea en el archivo, desde 1. */
  numero: number;
  texto: string;
}

/** Cada línea no vacía del archivo, en orden: quien reescribe necesita el orden. */
export type LineaJsonl<T> = { valor: T; ilegible?: undefined } | { valor?: undefined; ilegible: LineaIlegible };

/**
 * Parte el contenido en líneas. Una línea es legible si es JSON y `validar`
 * la acepta; si no, se devuelve como ilegible, sin intentar repararla: una
 * reparación equivocada es peor que una línea marcada.
 */
export function leerLineasJsonl<T>(contenido: string, validar: (valor: unknown) => valor is T): LineaJsonl<T>[] {
  const lineas: LineaJsonl<T>[] = [];
  contenido.split("\n").forEach((texto, i) => {
    if (texto.trim() === "") return;
    let valor: unknown;
    try {
      valor = JSON.parse(texto);
    } catch {
      lineas.push({ ilegible: { numero: i + 1, texto } });
      return;
    }
    lineas.push(validar(valor) ? { valor } : { ilegible: { numero: i + 1, texto } });
  });
  return lineas;
}

/** Un objeto (no `null`, no un array): la base de cualquier validación de línea. */
export function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/**
 * El aviso de líneas ilegibles, sin el contenido: los JSONL de este proyecto
 * guardan datos de clientes, y el log del servidor no es lugar para copiarlos.
 */
export function describirIlegibles(etiqueta: string, archivo: string, ilegibles: readonly LineaIlegible[]): string {
  const numeros = ilegibles.slice(0, 10).map((l) => l.numero).join(", ");
  const resto = ilegibles.length > 10 ? ` y ${ilegibles.length - 10} más` : "";
  return `[${etiqueta}] ${ilegibles.length} línea(s) ilegible(s) en ${archivo} (línea ${numeros}${resto}). Se ignoran al leer: revisarlas a mano.`;
}

/** Lee el archivo entero en líneas. Si todavía no existe, no hay líneas. */
export async function leerArchivoJsonl<T>(
  filePath: string,
  validar: (valor: unknown) => valor is T
): Promise<LineaJsonl<T>[]> {
  let contenido: string;
  try {
    contenido = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return leerLineasJsonl(contenido, validar);
}

export function ilegiblesDe<T>(lineas: readonly LineaJsonl<T>[]): LineaIlegible[] {
  return lineas.flatMap((l) => (l.ilegible ? [l.ilegible] : []));
}

/**
 * El aviso de líneas ilegibles de un archivo. Tolerar en silencio escondería
 * el problema; avisar en cada lectura lo convertiría en ruido que nadie mira.
 * Se avisa cuando cambian los números de línea: si una reescritura los corre,
 * el aviso sale de nuevo con los números que valen ahora.
 */
export class AvisoDeIlegibles {
  private ultimo = "";

  constructor(
    private readonly etiqueta: string,
    private readonly archivo: string
  ) {}

  avisar(ilegibles: readonly LineaIlegible[]): void {
    const clave = ilegibles.map((l) => l.numero).join(",");
    if (clave === this.ultimo) return;
    this.ultimo = clave;
    if (ilegibles.length > 0) console.warn(describirIlegibles(this.etiqueta, this.archivo, ilegibles));
  }
}

/**
 * El salto de línea que hay que anteponer a la próxima escritura si el
 * archivo termina en media línea, o `""`. Se mira en cada escritura y no una
 * vez por proceso: el corte también puede pasar con el proceso vivo (disco
 * lleno) o por una edición a mano. **Nunca tira**: no poder reparar no puede
 * impedir escribir.
 */
export async function saltoQueFalta(filePath: string, etiqueta: string): Promise<string> {
  let archivo;
  try {
    archivo = await open(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[${etiqueta}] no se pudo revisar el final de ${filePath}:`, error);
    }
    return "";
  }
  try {
    const { size } = await archivo.stat();
    if (size === 0) return "";
    const ultimo = Buffer.alloc(1);
    await archivo.read(ultimo, 0, 1, size - 1);
    if (ultimo[0] === 0x0a) return "";
    console.warn(`[${etiqueta}] ${filePath} terminaba en una línea cortada: se agrega el salto que faltaba.`);
    return "\n";
  } catch (error) {
    console.error(`[${etiqueta}] no se pudo revisar el final de ${filePath}:`, error);
    return "";
  } finally {
    // Un error al cerrar reemplazaría el valor de retorno y haría tirar a la
    // función: por eso va en su propio try.
    await archivo.close().catch((error: unknown) => {
      console.error(`[${etiqueta}] no se pudo cerrar ${filePath}:`, error);
    });
  }
}
