import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { REINTENTOS_ANTHROPIC, TIMEOUT_ANTHROPIC_MS } from "./limitesAnthropic.js";

/**
 * El único lugar del orchestrator donde se crea el cliente de Anthropic
 * (docs/TASKS.md Bloque 38b). Un test falla si aparece otro.
 *
 * Por qué: el SDK espera por default 10 minutos por intento, con 2
 * reintentos. Una llamada que se colgaba en vez de fallar tardaba hasta media
 * hora en convertirse en error, y mientras tanto no había `fallido` ni aviso
 * al broker. Un segundo cliente creado en otro lado volvería a esos 10
 * minutos sin que nada lo note. Los números están en `limitesAnthropic.ts`.
 *
 * Límite conocido del SDK 0.32: el timeout cubre la espera hasta que llegan
 * los encabezados de la respuesta, no la lectura del cuerpo. Una conexión que
 * se traba a mitad del cuerpo espera hasta que el socket se da por inactivo
 * (5 minutos).
 */

export interface OpcionesClienteAnthropic {
  apiKey: string;
  timeoutMs?: number;
  /** Para los tests: probar el timeout sin red, y sin reintentos. */
  maxRetries?: number;
  fetch?: ClientOptions["fetch"];
}

export function crearClienteAnthropic(opciones: OpcionesClienteAnthropic): Anthropic {
  return new Anthropic({
    apiKey: opciones.apiKey,
    timeout: opciones.timeoutMs ?? TIMEOUT_ANTHROPIC_MS,
    maxRetries: opciones.maxRetries ?? REINTENTOS_ANTHROPIC,
    fetch: opciones.fetch,
  });
}
