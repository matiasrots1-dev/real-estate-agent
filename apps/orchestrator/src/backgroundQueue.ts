/**
 * Cola de trabajo en background, serializada por conversación.
 *
 * Existe porque `/webhook` responde 200 apenas recibe el mensaje y procesa
 * después (el proveedor que reenvía los webhooks corta a los 3 segundos, y el
 * camino completo — clasificación con Claude, tools, redacción, envío — tarda
 * bastante más). Contestar rápido y procesar en background introduce un modo
 * de fallo que antes no existía: dos mensajes seguidos del mismo cliente
 * procesándose en paralelo y pisándose el estado de la conversación
 * (`FileConversationStateStore.save()` es leer-archivo-entero → mutar →
 * escribir-entero, sin lock). Mientras el procesamiento era sincrónico, el
 * reenviador esperaba la respuesta y eso serializaba las conversaciones de
 * casualidad; al contestar al toque, esa protección accidental se pierde.
 *
 * Por eso el trabajo se encadena **por conversación**: dos mensajes del mismo
 * teléfono corren uno después del otro, y conversaciones distintas siguen
 * corriendo en paralelo.
 */

export interface BackgroundQueue {
  /**
   * Encola trabajo para una conversación. No devuelve nada y **nunca lanza**:
   * el llamador ya respondió 200 y no tiene a quién reportarle un error.
   */
  enqueue(conversationId: string, task: () => Promise<void>): void;
  /**
   * Resuelve cuando no queda trabajo pendiente. Para tests (esperar de verdad
   * en vez de dormir un rato y cruzar los dedos) y para un futuro drain del
   * shutdown.
   */
  idle(): Promise<void>;
  /** Cuántas tareas hay encoladas o corriendo. */
  pending(): number;
}

export interface SerialConversationQueueOptions {
  /**
   * Techo por tarea. Si se vence, la cadena de esa conversación se libera para
   * que el resto de los mensajes no queden bloqueados para siempre.
   *
   * OJO: esto NO cancela el trabajo colgado — no hay forma de cancelar una
   * llamada HTTP ya emitida desde acá. Libera la cadena. O sea que en el caso
   * patológico de un timeout puede haber dos tareas de la misma conversación
   * solapadas, que es justo lo que la cola evita. Es un intercambio
   * deliberado: un solapamiento raro es preferible a que un cliente quede sin
   * respuesta para siempre y en silencio.
   */
  taskTimeoutMs?: number;
  /** Inyectable para testear el reporte de errores sin ensuciar la consola. */
  onError?: (error: unknown, conversationId: string) => void;
}

const DEFAULT_TASK_TIMEOUT_MS = 60_000;

function reportarPorDefecto(error: unknown, conversationId: string): void {
  // Sin el id de conversación (un teléfono) en el mensaje: es un dato personal
  // y el log no es un lugar donde deba quedar. Alcanza con saber que falló.
  void conversationId;
  console.error("[background] la tarea falló y se descartó:", error);
}

export class SerialConversationQueue implements BackgroundQueue {
  /** Punta de la cadena de promesas de cada conversación. */
  private readonly cadenas = new Map<string, Promise<void>>();
  private pendientes = 0;
  private readonly taskTimeoutMs: number;
  private readonly onError: (error: unknown, conversationId: string) => void;

  constructor(options: SerialConversationQueueOptions = {}) {
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.onError = options.onError ?? reportarPorDefecto;
  }

  enqueue(conversationId: string, task: () => Promise<void>): void {
    const anterior = this.cadenas.get(conversationId) ?? Promise.resolve();
    this.pendientes += 1;

    // El `.catch` va DENTRO de la cadena y no encima: así la promesa que queda
    // guardada en el mapa nunca está rechazada, y una tarea que falla no
    // bloquea ni arrastra a las siguientes de la misma conversación. Es
    // también lo que evita que un mensaje raro se convierta en un
    // unhandledRejection y se lleve puesto el proceso entero.
    const actual = anterior
      .then(() => this.correrConTecho(conversationId, task))
      .catch((error) => this.reportarSinPropagar(error, conversationId))
      .finally(() => {
        this.pendientes -= 1;
        // Sólo borra si sigue siendo la punta: si mientras tanto se encoló
        // otra tarea para la misma conversación, la entrada es de ella. Sin
        // esta comprobación el mapa crece para siempre, una entrada por
        // teléfono, en un proceso que corre semanas.
        if (this.cadenas.get(conversationId) === actual) {
          this.cadenas.delete(conversationId);
        }
      });

    this.cadenas.set(conversationId, actual);
  }

  async idle(): Promise<void> {
    // En loop y no un solo `allSettled`: una tarea puede encolar más trabajo
    // mientras corre, y esperar sólo las cadenas que existían al entrar
    // resolvería antes de tiempo. Un test que use eso pasa en verde sin haber
    // esperado nada.
    while (this.pendientes > 0) {
      await Promise.allSettled([...this.cadenas.values()]);
    }
  }

  pending(): number {
    return this.pendientes;
  }

  private async correrConTecho(conversationId: string, task: () => Promise<void>): Promise<void> {
    let temporizador: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        task(),
        new Promise<never>((_, reject) => {
          temporizador = setTimeout(
            () =>
              reject(
                new Error(
                  `La tarea de background superó ${this.taskTimeoutMs} ms; se libera la cola de esta conversación.`
                )
              ),
            this.taskTimeoutMs
          );
          // Un timer pendiente no debe mantener vivo el proceso.
          temporizador.unref?.();
        }),
      ]);
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }

  /**
   * Último anillo de la defensa: si el propio reporte de error explota (un
   * `onError` inyectado que lanza, una consola redirigida a algo roto), no
   * puede escapar de acá. Una excepción escapando de este punto vuelve a ser
   * un unhandledRejection.
   */
  private reportarSinPropagar(error: unknown, conversationId: string): void {
    try {
      this.onError(error, conversationId);
    } catch {
      /* no hay a dónde reportar; tragarlo es preferible a matar el proceso */
    }
  }
}
