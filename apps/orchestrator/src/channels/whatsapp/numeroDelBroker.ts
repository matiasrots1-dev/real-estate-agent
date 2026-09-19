/**
 * "Este número es el del broker": **una sola definición** para todo el
 * orchestrator (docs/TASKS.md Bloque 38g).
 *
 * La usan el ruteo por canal (`handleIncomingMessage`), el modo silencioso
 * (`SilentModeSender`) y el aviso de fallos (`app.ts`). Antes había dos: el
 * ruteo comparaba el texto exacto y el modo silencioso, solo los dígitos. Con
 * `BROKER_WHATSAPP_NUMBER=+972...`, los avisos le llegaban al broker pero sus
 * órdenes se ruteaban como de un cliente.
 *
 * Compara dígitos y nada más: no normaliza (no agrega ni saca el 9 de los
 * celulares argentinos). Dos números con los mismos dígitos son el mismo
 * número; cualquier normalización más floja podría confundir a un cliente
 * con el broker y darle acceso a las órdenes del canal broker.
 *
 * Sin número del broker configurado —`undefined` o vacío, que es lo que deja
 * `BROKER_WHATSAPP_NUMBER=` en el .env— nadie es el broker.
 */
export function esElNumeroDelBroker(numero: string | undefined, broker: string | undefined): boolean {
  const digitosDelBroker = soloDigitos(broker ?? "");
  if (!digitosDelBroker) return false;
  return soloDigitos(numero ?? "") === digitosDelBroker;
}

export function soloDigitos(numero: string): string {
  return numero.replace(/\D/g, "");
}
