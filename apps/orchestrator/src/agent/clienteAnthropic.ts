import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";

/**
 * El único lugar del orchestrator donde se crea el cliente de Anthropic
 * (docs/TASKS.md Bloque 38b). Un test falla si aparece otro `new Anthropic(`.
 *
 * Por qué: el SDK espera por default 10 minutos por intento, con 2
 * reintentos. Una llamada que se colgaba en vez de fallar tardaba hasta media
 * hora en convertirse en error, y mientras tanto no había `fallido` ni aviso
 * al broker. Un segundo cliente creado en otro lado volvería a esos 10
 * minutos sin que nada lo note.
 */

/**
 * 30 s por intento. De lo medido en producción (19/09): un mensaje entero
 * tarda 7,6 s la mitad de las veces y 18,4 s como máximo, con 2 o 3 llamadas.
 * La llamada más pesada (el planificador, 1024 tokens) queda holgada.
 */
export const TIMEOUT_ANTHROPIC_MS = 30_000;

/**
 * Los reintentos del SDK se mantienen: sirven ante una sobrecarga momentánea
 * (529). Peor caso de una llamada colgada: unos 90 s en vez de media hora.
 */
export const REINTENTOS_ANTHROPIC = 2;

export interface OpcionesClienteAnthropic {
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Solo para tests: un `fetch` propio, para probar el timeout sin red. */
  fetch?: ClientOptions["fetch"];
}

export function crearClienteAnthropic(opciones: OpcionesClienteAnthropic): Anthropic {
  return new Anthropic({
    apiKey: opciones.apiKey,
    timeout: opciones.timeoutMs ?? TIMEOUT_ANTHROPIC_MS,
    maxRetries: opciones.maxRetries ?? REINTENTOS_ANTHROPIC,
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  });
}

/**
 * Lee `ANTHROPIC_TIMEOUT_MS`. Un valor que no es un entero positivo se ignora
 * con un aviso y se usa el de por defecto: el SDK tira al construir el
 * cliente con un timeout inválido, y con eso el bot moriría al arrancar y
 * systemd lo reiniciaría en loop (modo de fallo 3 del pre-mortem).
 */
export function leerTimeoutAnthropic(valor: string | undefined): number {
  if (valor === undefined || valor.trim() === "") return TIMEOUT_ANTHROPIC_MS;
  const numero = Number(valor.trim());
  if (Number.isInteger(numero) && numero > 0) return numero;
  console.warn(
    `ANTHROPIC_TIMEOUT_MS="${valor}" no es un número entero de milisegundos: se usa el de por defecto (${TIMEOUT_ANTHROPIC_MS}).`
  );
  return TIMEOUT_ANTHROPIC_MS;
}
