import type { AuditLogEntry, IntentCatalog } from "shared-types";
import type { UltimoContacto } from "./ultimoContactoStore.js";

/**
 * La plantilla fija se manda **una vez por conversación**; después el agente
 * se calla hasta que el broker responda (docs/TASKS.md Bloque 31).
 *
 * El problema medido: con el modo silencioso apagado, los 16 leads etiquetados
 * recibirían 57 envíos de la misma frase, y una sola persona 16 seguidas en
 * una conversación de 18 mensajes. El intent estaba bien clasificado — el
 * problema era qué se hacía con él, así que ninguna métrica del clasificador
 * lo mostraba.
 *
 * Lo que NO cambia: el mensaje se sigue recibiendo, clasificando, auditando y
 * escalando al broker. Lo único que se suprime es el envío al cliente.
 */

/**
 * Techo temporal: pasado esto la plantilla puede volver a salir aunque no haya
 * llegado ningún eco.
 *
 * Existe porque la condición para volver a hablar depende del eco de
 * coexistencia, que es best-effort — Meta no lo reintenta y sólo se registra
 * si el destinatario matchea un lead conocido. Sin este techo, un eco perdido
 * dejaría a esa persona sin recibir nada **para siempre**.
 */
export const DIAS_TECHO_SILENCIO = 7;

/**
 * Los intents cuya respuesta es texto fijo, derivados del catálogo en runtime
 * (CLAUDE.md secc. 7: nada de listas de intents hardcodeadas en TypeScript).
 *
 * Una plantilla con `{variables}` queda AFUERA: su texto cambia en cada envío
 * porque lleva información real — la dirección, el horario, el clima. Repetir
 * eso no es lo que rompe la conversación.
 */
export function plantillasFijas(catalog: IntentCatalog): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const intent of catalog.intents) {
    if (intent.response.style !== "template") continue;
    const template = intent.response.template;
    if (!template) continue;
    if (/\{[^}]+\}/.test(template)) continue;
    ids.add(intent.id);
  }
  return ids;
}

export interface DecisionPlantilla {
  suprimir: boolean;
  /** Qué se registra en el audit log cuando se suprime. */
  motivo?: string;
}

const NO_SUPRIMIR: DecisionPlantilla = { suprimir: false };

export interface EntradaPrevia {
  matchedIntentId: string;
  timestamp: string;
  responseSent?: string;
}

/**
 * `historial` son las entradas **de esta conversación**, en cualquier orden.
 *
 * La supresión es por conversación en total, **no una por intent**: de las 7
 * plantillas fijas del catálogo, las 7 dicen lo mismo ("te paso con el
 * asesor"). Suprimir por intent le mandaría a la misma persona tres frases
 * distintas con el mismo contenido, que es el problema original con otra ropa.
 */
export function decidirPlantilla(args: {
  intentId: string;
  fijas: ReadonlySet<string>;
  historial: readonly EntradaPrevia[];
  ultimoContacto: UltimoContacto | null;
  ahora: Date;
}): DecisionPlantilla {
  const { intentId, fijas, historial, ultimoContacto, ahora } = args;
  if (!fijas.has(intentId)) return NO_SUPRIMIR;

  // La más reciente que EFECTIVAMENTE salió. `responseSent` vacío significa
  // que no se envió nada (modo silencioso, o una supresión previa), y eso no
  // gasta el único envío permitido.
  let ultimaEnviada: number | undefined;
  for (const entrada of historial) {
    if (!fijas.has(entrada.matchedIntentId)) continue;
    if (!entrada.responseSent) continue;
    const t = new Date(entrada.timestamp).getTime();
    if (Number.isNaN(t)) continue;
    if (ultimaEnviada === undefined || t > ultimaEnviada) ultimaEnviada = t;
  }
  if (ultimaEnviada === undefined) return NO_SUPRIMIR;

  // El broker contestó después de la plantilla: a estos efectos la
  // conversación arranca de nuevo y la plantilla puede volver a salir.
  //
  // `origen === "manual"` no es un detalle: el store guarda también los
  // contactos del sistema, y el job de recontacto del Bloque 27 va a escribir
  // `"sistema"` cuando se cablee. Mirando sólo la fecha, el recontacto
  // automático del propio agente contaría como "el broker respondió" y la
  // repetición volvería sin que nadie toque este archivo.
  if (ultimoContacto && ultimoContacto.origen === "manual") {
    const contactoAt = new Date(ultimoContacto.contactadoAt).getTime();
    if (!Number.isNaN(contactoAt) && contactoAt > ultimaEnviada) return NO_SUPRIMIR;
  }

  const dias = (ahora.getTime() - ultimaEnviada) / (24 * 3600 * 1000);
  if (dias >= DIAS_TECHO_SILENCIO) return NO_SUPRIMIR;

  return {
    suprimir: true,
    motivo:
      `Plantilla fija ya enviada en esta conversación y el broker todavía no respondió: ` +
      `el cliente NO recibió nada. Se escaló igual (docs/TASKS.md Bloque 31).`,
  };
}
