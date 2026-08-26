import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PurgeResult } from "./purge.js";

/**
 * Corpus de cómo escribe el broker, para que los borradores suenen a él.
 *
 * Se alimenta del eco de coexistencia: cada mensaje que manda desde el celular
 * a un contacto conocido se guarda junto al intent al que estaba respondiendo.
 * Después esos ejemplos se le muestran a Claude cuando tiene que redactar un
 * borrador del mismo intent.
 *
 * **El texto se guarda ya anonimizado**, no en crudo. La anonimización ocurre
 * al escribir y no al usar, así el texto original nunca toca el disco: si el
 * archivo se filtra, no hay nombres, teléfonos, mails ni direcciones adentro.
 * Es irreversible a propósito — para aprender tono no hace falta el original.
 *
 * Dos cosas que **no** se guardan: a quién le escribió (el corpus es de estilo,
 * no un registro de conversaciones) y el mensaje del cliente. Sin el
 * destinatario, un ejemplo no se puede volver a atar a una persona.
 */
export interface EjemploDeEstilo {
  /** Intent al que el broker estaba respondiendo, para elegir ejemplos del caso. */
  intent: string;
  /** El texto del broker, ya sin identificadores. */
  texto: string;
  /** Cuándo lo escribió (ISO). Alimenta la retención. */
  cuando: string;
}

export interface EstiloBrokerStore {
  guardar(ejemplo: EjemploDeEstilo): Promise<void>;
  /** Los más recientes de ese intent, para armar el prompt. */
  ejemplosDe(intent: string, cuantos: number): Promise<EjemploDeEstilo[]>;
  all(): Promise<EjemploDeEstilo[]>;
  purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult>;
}

/** Un ejemplo de una línea no enseña nada; uno larguísimo se come el prompt. */
const LARGO_MINIMO = 15;
const LARGO_MAXIMO = 600;

export function sirveComoEjemplo(texto: string): boolean {
  const limpio = texto.trim();
  return limpio.length >= LARGO_MINIMO && limpio.length <= LARGO_MAXIMO;
}

function filtrarYOrdenar(todos: EjemploDeEstilo[], intent: string, cuantos: number): EjemploDeEstilo[] {
  return todos
    .filter((e) => e.intent === intent)
    .sort((a, b) => b.cuando.localeCompare(a.cuando))
    .slice(0, cuantos);
}

export class InMemoryEstiloBrokerStore implements EstiloBrokerStore {
  private datos: EjemploDeEstilo[] = [];

  async guardar(ejemplo: EjemploDeEstilo): Promise<void> {
    this.datos.push(ejemplo);
  }

  async ejemplosDe(intent: string, cuantos: number): Promise<EjemploDeEstilo[]> {
    return filtrarYOrdenar(this.datos, intent, cuantos);
  }

  async all(): Promise<EjemploDeEstilo[]> {
    return [...this.datos];
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const sobreviven = this.datos.filter((e) => new Date(e.cuando).getTime() >= cutoff.getTime());
    const borrados = this.datos.length - sobreviven.length;
    if (!dryRun) this.datos = sobreviven;
    // La muestra va vacía: un ejemplo del corpus ES el texto, y el reporte de
    // purgado no puede convertirse en una copia de lo que se está borrando.
    return { borrados, muestra: [] };
  }
}

// TODO(fase 2+): migrar a Postgres junto con el resto de los stores.
export class FileEstiloBrokerStore implements EstiloBrokerStore {
  constructor(private readonly filePath: string) {}

  async guardar(ejemplo: EjemploDeEstilo): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(ejemplo) + "\n", "utf-8");
  }

  async ejemplosDe(intent: string, cuantos: number): Promise<EjemploDeEstilo[]> {
    return filtrarYOrdenar(await this.all(), intent, cuantos);
  }

  async all(): Promise<EjemploDeEstilo[]> {
    try {
      const crudo = await readFile(this.filePath, "utf-8");
      return crudo
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as EjemploDeEstilo);
    } catch {
      return [];
    }
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const todos = await this.all();
    const sobreviven = todos.filter((e) => new Date(e.cuando).getTime() >= cutoff.getTime());
    const borrados = todos.length - sobreviven.length;
    if (!dryRun && borrados > 0) {
      const contenido = sobreviven.map((r) => JSON.stringify(r)).join("\n");
      await writeFile(this.filePath, contenido + (sobreviven.length ? "\n" : ""), "utf-8");
    }
    return { borrados, muestra: [] };
  }
}
