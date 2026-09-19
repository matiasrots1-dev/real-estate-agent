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
    } else if (entrada.etapa !== "recibido") {
      salida[i] = entrada;
    }
  }
  return salida;
}

/**
 * Una entrada resuelta tiene un intent real. Una `recibido` que quedó sola y
 * una `fallido` llevan un intent centinela, que no sirve para nada que razone
 * sobre el intent: el corpus de estilo, las mediciones del clasificador.
 */
export function esResuelta(entrada: ConEtapa): boolean {
  return entrada.etapa === undefined;
}
