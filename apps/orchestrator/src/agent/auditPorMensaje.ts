/**
 * Una entrada por mensaje en el audit log (docs/TASKS.md Bloque 34).
 *
 * Desde el Bloque 34, cada mensaje entrante deja DOS entradas: una `recibido`,
 * escrita al llegar y antes de clasificar, y la que lo resuelve (o una
 * `fallido`, si el procesamiento tiró). Las dos comparten el `messageId` de
 * Meta.
 *
 * Todo lo que lee el audit log para reconstruir conversaciones o contar
 * mensajes tiene que pasar por `colapsarPorMensaje`. Sin eso cambia de número
 * sin que nadie lo toque: el contexto del clasificador repetiría cada mensaje,
 * `pendientes` contaría el doble, y las mediciones del clasificador saldrían
 * mal (modo de fallo 2 del pre-mortem).
 *
 * El archivo en disco conserva las dos entradas a propósito: un mensaje que se
 * queda solo con su `recibido` es la prueba de que llegó y nunca se resolvió.
 * Por eso el colapso se hace al leer y no en `readAll()`: si lo hiciera
 * `readAll()`, la purga de retención reescribiría el archivo ya colapsado y
 * borraría registros sin contarlos como borrados.
 */

/** Intent centinela de la entrada escrita al llegar. No es un id del catálogo. */
export const INTENT_SIN_CLASIFICAR = "sin_clasificar";

/** Intent centinela de un mensaje cuyo procesamiento falló. No es un id del catálogo. */
export const INTENT_PROCESAMIENTO_FALLIDO = "procesamiento_fallido";

interface ConEtapa {
  messageId?: string;
  etapa?: string;
}

/**
 * Deja una sola entrada por `messageId`. La que resuelve el mensaje reemplaza
 * a su `recibido`, en la posición del `recibido`, que es el orden de llegada.
 * Si un mensaje solo tiene su `recibido`, se conserva: llegó y no se resolvió.
 *
 * Gana la etapa más avanzada, no la última escrita: resuelta > `fallido` >
 * `recibido`. Si el proceso se reinicia, el dedup en memoria se pierde y Meta
 * puede reentregar un mensaje que ya se había contestado. Si ese reproceso
 * falla, el `fallido` no puede tapar la respuesta que el cliente sí recibió.
 *
 * Las entradas sin `messageId` pasan sin tocar: son las anteriores al Bloque
 * 34 y las de los jobs, que no responden a un mensaje entrante.
 */
export function colapsarPorMensaje<T extends ConEtapa>(entradas: readonly T[]): T[] {
  const salida: T[] = [];
  const posicion = new Map<string, number>();
  for (const entrada of entradas) {
    if (!entrada.messageId) {
      salida.push(entrada);
      continue;
    }
    const i = posicion.get(entrada.messageId);
    if (i === undefined) {
      posicion.set(entrada.messageId, salida.length);
      salida.push(entrada);
    } else if (rango(entrada) >= rango(salida[i])) {
      salida[i] = entrada;
    }
  }
  return salida;
}

/**
 * `envio_fallido` (docs/TASKS.md Bloque 38d) tiene el mismo rango que una
 * resuelta, y entre iguales gana la última escrita. Así reemplaza a la
 * resuelta, que se escribe antes del envío y dice que la respuesta salió; y
 * un reproceso posterior cuyo envío sí sale vuelve a ganarle.
 */
function rango(entrada: ConEtapa): number {
  if (entrada.etapa === "recibido") return 0;
  if (entrada.etapa === "fallido") return 1;
  if (entrada.etapa === "envio_fallido") return 2;
  return 2;
}

/**
 * Una entrada resuelta tiene un intent real. Una `recibido` que quedó sola y
 * una `fallido` llevan un intent centinela, que no sirve para nada que razone
 * sobre el intent: el corpus de estilo, las mediciones del clasificador. Una
 * `envio_fallido` sí tiene el intent real: el mensaje se clasificó, lo que
 * falló fue mandar la respuesta.
 */
export function esResuelta(entrada: ConEtapa): boolean {
  return entrada.etapa === undefined || entrada.etapa === "envio_fallido";
}
