/**
 * Deduplicación de mensajes entrantes por `id` de Meta (`wamid.XXX`).
 *
 * De dónde vienen los duplicados: el proveedor que nos reenvía los webhooks
 * **no reintenta** (un solo POST por evento, a propósito). Pero su forward
 * está enganchado al principio de su webhook, antes de que su propio CRM
 * procese. Si el CRM devuelve un no-200, **Meta** reintenta el POST aguas
 * arriba y el forward se dispara otra vez con el mismo message id. Midieron
 * 1,83 POST de Meta por evento durante un bug.
 *
 * Por eso responder rápido no alcanza: nuestra latencia no interviene en esa
 * cadena. El ACK adelantado (docs/TASKS.md Bloque 18) eliminó los duplicados
 * que causaba *nuestro* timeout; estos son de otra fuente y hay que filtrarlos
 * acá.
 *
 * Dos decisiones que vale la pena tener presentes:
 *
 * - **Se marca al recibir, no al terminar.** El reintento de Meta puede llegar
 *   mientras todavía estamos procesando el original, así que marcar al final
 *   no filtraría nada. La contra es que si el proceso muere procesando, el
 *   reintento se descarta como duplicado y el mensaje se pierde. Es el mismo
 *   agujero que ya cubre el riesgo abierto de la cola durable, no uno nuevo.
 * - **Ante la duda, se procesa.** Un duplicado de más le manda al cliente una
 *   respuesta repetida: molesto y visible. Un falso positivo lo deja sin
 *   respuesta para siempre, y del lado nuestro no se nota nada. Los dos
 *   errores no son simétricos y el código se inclina a propósito.
 */

export interface MessageDeduplicator {
  /**
   * Marca el id y devuelve `true` si es la primera vez que se lo ve (o sea:
   * hay que procesarlo). `false` significa duplicado, descartar.
   *
   * Es **sincrónico a propósito**: chequear y marcar tienen que ser una sola
   * operación. Partido en dos `await`, dos reintentos de Meta que llegan a la
   * vez pasan los dos el chequeo antes de que ninguno marque, y la dedup no
   * filtra nada justo en el caso para el que existe. En Node, single-threaded,
   * un método sincrónico no puede intercalarse.
   */
  registrarSiEsNuevo(messageId: string): boolean;
  /** Cuántos duplicados se descartaron desde que arrancó el proceso. */
  duplicadosDescartados(): number;
  /** Cuántos ids hay retenidos ahora mismo. */
  size(): number;
}

export interface LruMessageDeduplicatorOptions {
  /**
   * Cuántos ids retener. El techo protege la memoria de un proceso que corre
   * semanas; el costo de quedarse corto es dejar pasar un duplicado, no
   * descartar un mensaje bueno.
   *
   * 10.000 es holgado para el volumen de un broker individual: cubre meses de
   * mensajes, y con eso la ventana de reintento de Meta (backoff largo, mucho
   * más que los 3 s del proveedor) queda cubierta de sobra.
   */
  capacidad?: number;
  onDuplicado?: (messageId: string, totalDescartados: number) => void;
  onDesalojo?: (capacidad: number) => void;
}

const CAPACIDAD_POR_DEFECTO = 10_000;

function avisarDuplicadoPorDefecto(messageId: string, totalDescartados: number): void {
  // El wamid no es un dato personal (no es el teléfono ni el texto), así que
  // sí se loguea: es lo que permite cruzar con los logs del proveedor cuando
  // el conteo empieza a subir.
  console.warn(
    `[dedup] mensaje duplicado descartado id=${messageId} (van ${totalDescartados} desde que arrancó el proceso)`
  );
}

function avisarDesalojoPorDefecto(capacidad: number): void {
  console.warn(
    `[dedup] el registro llegó a su techo de ${capacidad} ids y empezó a descartar los más viejos. ` +
      `Si esto pasa seguido, subí la capacidad: un id desalojado antes de tiempo deja pasar un duplicado.`
  );
}

/**
 * Registro LRU en memoria. En memoria y no en disco a propósito: los ids no
 * tienen valor más allá de la ventana de reintento, y persistirlos los metería
 * bajo la política de retención (docs/TASKS.md Bloque 15) por nada. La contra
 * está anotada como riesgo abierto: un reinicio vacía el registro, así que un
 * reintento de Meta posterior a un reinicio se procesa como nuevo.
 */
export class LruMessageDeduplicator implements MessageDeduplicator {
  private readonly vistos = new Set<string>();
  private readonly capacidad: number;
  private descartados = 0;
  private yaAvisoDelTecho = false;
  private readonly onDuplicado: (messageId: string, totalDescartados: number) => void;
  private readonly onDesalojo: (capacidad: number) => void;

  constructor(options: LruMessageDeduplicatorOptions = {}) {
    this.capacidad = Math.max(1, options.capacidad ?? CAPACIDAD_POR_DEFECTO);
    this.onDuplicado = options.onDuplicado ?? avisarDuplicadoPorDefecto;
    this.onDesalojo = options.onDesalojo ?? avisarDesalojoPorDefecto;
  }

  registrarSiEsNuevo(messageId: string): boolean {
    // Sin id utilizable no hay con qué deduplicar. Se procesa: mejor una
    // respuesta repetida que un cliente sin respuesta (ver el encabezado).
    if (typeof messageId !== "string" || messageId.trim() === "") return true;

    if (this.vistos.has(messageId)) {
      // Refresca la posición: si Meta reintenta varias veces, cada reintento
      // mantiene vivo el id en vez de dejarlo envejecer hacia el desalojo.
      this.vistos.delete(messageId);
      this.vistos.add(messageId);
      this.descartados += 1;
      this.reportarSinPropagar(() => this.onDuplicado(messageId, this.descartados));
      return false;
    }

    this.vistos.add(messageId);
    if (this.vistos.size > this.capacidad) {
      // Un Set en JS itera en orden de inserción: el primero es el más viejo.
      const masViejo = this.vistos.values().next().value;
      if (masViejo !== undefined) this.vistos.delete(masViejo);
      if (!this.yaAvisoDelTecho) {
        this.yaAvisoDelTecho = true;
        this.reportarSinPropagar(() => this.onDesalojo(this.capacidad));
      }
    }
    return true;
  }

  duplicadosDescartados(): number {
    return this.descartados;
  }

  size(): number {
    return this.vistos.size;
  }

  /**
   * Un callback de logging que explota no puede tumbar el webhook: esto corre
   * en el camino del request, antes de encolar.
   */
  private reportarSinPropagar(fn: () => void): void {
    try {
      fn();
    } catch {
      /* el logging no es motivo para perder un mensaje */
    }
  }
}
