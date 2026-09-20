import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PurgeResult } from "./purge.js";
import { AvisoDeIlegibles, esObjeto, ilegiblesDe, leerArchivoJsonl, saltoQueFalta } from "./jsonl.js";

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
 *
 * ## Retención: sin plazo, y es una decisión
 *
 * Este store **no se purga por antigüedad** y **no está cableado al barrido de
 * `jobs/retention.ts`**, a diferencia de todos los demás. Decisión del dueño
 * del repo: como el texto va anonimizado y sin destinatario, no identifica a
 * nadie, y borrarlo sólo haría que el agente desaprenda.
 *
 * `purgeOlderThan` se conserva igual, aunque nadie lo llame automáticamente:
 * es la vía para vaciar el corpus si esa decisión se revisa, o para atender un
 * pedido puntual de borrado.
 *
 * **La contracara, que hay que tener presente**: la anonimización es por
 * patrones y por lista de nombres conocidos, o sea *mejor esfuerzo*, no
 * garantía. Lo que no se haya redactado al guardar queda para siempre — un
 * apodo, un nombre que no estaba en Tokko, un detalle identificable
 * ("el depto que da al patio de la escuela"). Con plazo, un error se vencía
 * solo; sin plazo, no. Por eso conviene correr una re-anonimización periódica
 * sobre el corpus a medida que se conocen más nombres.
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
  /**
   * Reemplaza el corpus entero. La usa la re-anonimizacion periodica: como el
   * texto se guarda ya anonimizado, un identificador que no se conocia al
   * escribir queda ahi para siempre; volver a pasar el anonimizador con la
   * lista de nombres actualizada es lo que lo limpia.
   *
   * Devuelve cuántas líneas ilegibles descartó: son texto que **no** pasó por
   * el anonimizador, así que no pueden quedarse (docs/TASKS.md Bloque 41).
   */
  reescribir(ejemplos: EjemploDeEstilo[]): Promise<{ ilegiblesDescartadas: number }>;
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

  async reescribir(ejemplos: EjemploDeEstilo[]): Promise<{ ilegiblesDescartadas: number }> {
    this.datos = [...ejemplos];
    return { ilegiblesDescartadas: 0 };
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

const ETIQUETA = "estilo";

/** Un ejemplo legible: los campos que cualquier lector del corpus recorre. */
function esEjemplo(valor: unknown): valor is EjemploDeEstilo {
  return (
    esObjeto(valor) &&
    typeof valor.intent === "string" &&
    typeof valor.texto === "string" &&
    typeof valor.cuando === "string" &&
    !Number.isNaN(Date.parse(valor.cuando))
  );
}

// TODO(fase 2+): migrar a Postgres junto con el resto de los stores.
export class FileEstiloBrokerStore implements EstiloBrokerStore {
  private readonly aviso: AvisoDeIlegibles;

  constructor(private readonly filePath: string) {
    this.aviso = new AvisoDeIlegibles(ETIQUETA, filePath);
  }

  async guardar(ejemplo: EjemploDeEstilo): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // El salto que falta va en la misma escritura: si el archivo terminó en
    // media línea, este ejemplo no se pega a ella (docs/TASKS.md Bloque 37).
    const prefijo = await saltoQueFalta(this.filePath, ETIQUETA);
    await appendFile(this.filePath, `${prefijo}${JSON.stringify(ejemplo)}\n`, "utf-8");
  }

  async ejemplosDe(intent: string, cuantos: number): Promise<EjemploDeEstilo[]> {
    return filtrarYOrdenar(await this.all(), intent, cuantos);
  }

  /**
   * **Una línea rota no vacía el corpus** (docs/TASKS.md Bloque 41). Antes el
   * parseo estaba envuelto en un `catch { return [] }`: con una sola línea
   * ilegible esto devolvía cero ejemplos, y `estilo:reanonimizar` —que hace
   * `all()` y después `reescribir()`— escribía un archivo vacío. Son 112
   * ejemplos que no se pueden reconstruir: el texto crudo nunca toca el disco.
   */
  async all(): Promise<EjemploDeEstilo[]> {
    const lineas = await leerArchivoJsonl(this.filePath, esEjemplo);
    this.aviso.avisar(ilegiblesDe(lineas));
    return lineas.flatMap((l) => (l.valor ? [l.valor] : []));
  }

  /**
   * Reescribe el corpus entero. Es lo que usa `estilo:reanonimizar`, y por eso
   * **las líneas ilegibles se descartan** en vez de conservarse: el objetivo
   * de esa operación es garantizar que todo el archivo pasó por el
   * anonimizador, y una línea rota conservada es texto que no pasó. Va contra
   * la regla del Bloque 39 ("las rotas se conservan en su lugar") a propósito
   * y sólo acá; la purga, más abajo, sí las conserva.
   *
   * Devuelve cuántas descartó, para que quien reanonimiza lo sepa.
   */
  async reescribir(ejemplos: EjemploDeEstilo[]): Promise<{ ilegiblesDescartadas: number }> {
    const lineas = await leerArchivoJsonl(this.filePath, esEjemplo);
    const descartadas = ilegiblesDe(lineas).length;
    await this.escribirTodo(ejemplos.map((r) => JSON.stringify(r)));
    return { ilegiblesDescartadas: descartadas };
  }

  /**
   * Acá las ilegibles **sí** se conservan, fechadas por posición como en el
   * Bloque 37: la fecha de una línea rota es la del próximo ejemplo legible.
   * El objetivo de la purga es no perder ejemplos, no garantizar que pasaron
   * por el anonimizador.
   */
  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const lineas = await leerArchivoJsonl(this.filePath, esEjemplo);
    this.aviso.avisar(ilegiblesDe(lineas));
    const corte = cutoff.getTime();

    const fechas: Array<string | undefined> = new Array(lineas.length);
    let siguiente: string | undefined;
    for (let i = lineas.length - 1; i >= 0; i--) {
      const valor = lineas[i].valor;
      if (valor) siguiente = valor.cuando;
      fechas[i] = siguiente;
    }

    const sobreviven: string[] = [];
    let borrados = 0;
    lineas.forEach((linea, i) => {
      const fecha = fechas[i];
      if (fecha !== undefined && new Date(fecha).getTime() < corte) {
        borrados += 1;
        return;
      }
      sobreviven.push(linea.valor ? JSON.stringify(linea.valor) : linea.ilegible.texto);
    });

    if (!dryRun && borrados > 0) await this.escribirTodo(sobreviven);
    // La muestra va vacía: un ejemplo del corpus ES el texto, y el reporte de
    // purgado no puede convertirse en una copia de lo que se está borrando.
    return { borrados, muestra: [] };
  }

  /**
   * A un temporal y después `rename`: un corte a mitad de la reescritura
   * borraría el corpus entero, y no se puede reconstruir (Bloque 41).
   */
  private async escribirTodo(lineas: string[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const contenido = lineas.length > 0 ? `${lineas.join("\n")}\n` : "";
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, contenido, "utf-8");
      await rename(tmp, this.filePath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
}
