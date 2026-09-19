/**
 * Cuánto se espera a Claude (docs/TASKS.md Bloque 38b). Sin dependencias: lo
 * usan `config.ts` para leer el .env y `clienteAnthropic.ts` para crear el
 * cliente, y la config no tiene por qué cargar el SDK.
 *
 * Los números tienen que cerrar con el techo por tarea de la cola
 * (`backgroundQueue.ts`, 90 s). Una llamada colgada falla recién después de
 * todos sus intentos: (1 + reintentos) × timeout, más una espera corta entre
 * intentos. Si eso más el resto del mensaje pasa el techo, la cola abandona
 * la tarea antes de que se escriba el `fallido`, y el mensaje siguiente de la
 * misma conversación arranca en paralelo. Un test lo verifica.
 */

/**
 * 25 s por intento. De lo medido en producción (19/09): un mensaje entero
 * tarda 7,6 s la mitad de las veces y 18,4 s como máximo, con 2 o 3 llamadas.
 */
export const TIMEOUT_ANTHROPIC_MS = 25_000;

/**
 * Un reintento: cubre una sobrecarga momentánea (529), que vuelve rápido. Con
 * dos, una llamada colgada tardaba unos 91 s en fallar y pasaba el techo de
 * la cola (hallazgo de la revisión del PR #39).
 */
export const REINTENTOS_ANTHROPIC = 1;

/**
 * Rango aceptado para `ANTHROPIC_TIMEOUT_MS`. Por debajo de 1 s es casi seguro
 * un error de unidad (`30` pensando en segundos) y haría fallar todas las
 * llamadas. Por encima de 30 s, con el reintento y lo que tarda el resto del
 * mensaje, una llamada colgada se acerca al techo de la cola.
 */
export const TIMEOUT_ANTHROPIC_MIN_MS = 1_000;
export const TIMEOUT_ANTHROPIC_MAX_MS = 30_000;

/**
 * Lee `ANTHROPIC_TIMEOUT_MS`. Un valor fuera de rango o que no es un entero se
 * ignora con un aviso y se usa el de por defecto: el SDK tira al construir el
 * cliente con un timeout inválido, y con eso el bot moriría al arrancar y
 * systemd lo reiniciaría en loop (modo de fallo 3 del pre-mortem).
 */
export function leerTimeoutAnthropic(valor: string | undefined): number {
  if (valor === undefined || valor.trim() === "") return TIMEOUT_ANTHROPIC_MS;
  const texto = valor.trim();
  const numero = /^\d+$/.test(texto) ? Number(texto) : NaN;
  if (numero >= TIMEOUT_ANTHROPIC_MIN_MS && numero <= TIMEOUT_ANTHROPIC_MAX_MS) return numero;
  console.warn(
    `ANTHROPIC_TIMEOUT_MS="${valor}" no es un entero de milisegundos entre ${TIMEOUT_ANTHROPIC_MIN_MS} y ` +
      `${TIMEOUT_ANTHROPIC_MAX_MS}: se usa el de por defecto (${TIMEOUT_ANTHROPIC_MS}).`
  );
  return TIMEOUT_ANTHROPIC_MS;
}
