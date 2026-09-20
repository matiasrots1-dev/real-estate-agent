import type { AuditLogEntry, IntentCatalog } from "shared-types";
import { contactoDelBroker, type UltimoContacto } from "./ultimoContactoStore.js";

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
 * Las frases de espera del catálogo, por TEXTO (docs/TASKS.md Bloque 38e).
 *
 * Antes esto eran ids de intent, y la supresión se decidía por el intent
 * matcheado. No alcanza: desde el Bloque 38c, un escalamiento por baja
 * confianza, un flujo de visitas o la red de última línea mandan la frase de
 * espera del catálogo con el intent que sea. Mirando el texto, cuentan todos.
 *
 * Qué es una frase de espera lo dice el catálogo (`response.espera`), no una
 * regla derivada: una despedida ("Gracias por avisarme...") también es texto
 * fijo y no tiene por qué compartir el cupo.
 */
export function frasesDeEspera(catalog: IntentCatalog): ReadonlySet<string> {
  const textos = new Set<string>();
  for (const intent of catalog.intents) {
    if (intent.response.espera !== true) continue;
    const template = intent.response.template;
    if (template) textos.add(template);
  }
  return textos;
}

export interface DecisionPlantilla {
  suprimir: boolean;
  /** Qué se registra en el audit log cuando se suprime. */
  motivo?: string;
}

const NO_SUPRIMIR: DecisionPlantilla = { suprimir: false };

export interface EntradaPrevia {
  timestamp: string;
  responseSent?: string;
  fraseDeEspera?: boolean;
}

/**
 * `historial` son las entradas **de esta conversación**, en cualquier orden.
 *
 * La supresión es por conversación en total, **no una por frase**: las frases
 * de espera del catálogo dicen todas lo mismo ("te paso con el asesor").
 * Suprimir por frase le mandaría a la misma persona tres versiones del mismo
 * contenido, que es el problema original con otra ropa.
 */
export function decidirPlantilla(args: {
  texto: string;
  esperas: ReadonlySet<string>;
  historial: readonly EntradaPrevia[];
  ultimoContacto: UltimoContacto | null;
  ahora: Date;
}): DecisionPlantilla {
  const { texto, esperas, historial, ultimoContacto, ahora } = args;
  if (!esperas.has(texto)) return NO_SUPRIMIR;

  // La más reciente que EFECTIVAMENTE salió. `responseSent` vacío significa
  // que no se envió nada (modo silencioso, una supresión previa, o un envío
  // que falló), y eso no gasta el único envío permitido.
  let ultimaEnviada: number | undefined;
  for (const entrada of historial) {
    if (!entrada.responseSent) continue;
    // El marcador lo escribió el envío, mirando el catálogo de ese momento.
    // El texto es el respaldo para las entradas anteriores al Bloque 38e. Sin
    // el marcador, editar una frase del catálogo le devolvería el cupo a toda
    // conversación que tuviera la versión vieja en el historial, y la frase
    // saldría de nuevo (revisión del PR #42).
    if (entrada.fraseDeEspera !== true && !esperas.has(entrada.responseSent)) continue;
    const t = new Date(entrada.timestamp).getTime();
    if (Number.isNaN(t)) continue;
    if (ultimaEnviada === undefined || t > ultimaEnviada) ultimaEnviada = t;
  }
  if (ultimaEnviada === undefined) return NO_SUPRIMIR;

  // El broker contestó después de la plantilla: a estos efectos la
  // conversación arranca de nuevo y la plantilla puede volver a salir.
  //
  // Se mira la fecha del contacto **del broker**, no la del último contacto:
  // el store guarda también los del sistema, y el job de recontacto del
  // Bloque 27 va a escribir `"sistema"` cuando se cablee. Mirando sólo la
  // fecha, el recontacto automático del propio agente contaría como "el
  // broker respondió" y la repetición volvería sin que nadie toque este
  // archivo (docs/TASKS.md Bloques 31 y 38f).
  const contactoManual = contactoDelBroker(ultimoContacto);
  if (contactoManual !== null && contactoManual > ultimaEnviada) return NO_SUPRIMIR;

  const dias = (ahora.getTime() - ultimaEnviada) / (24 * 3600 * 1000);
  if (dias >= DIAS_TECHO_SILENCIO) return NO_SUPRIMIR;

  return {
    suprimir: true,
    motivo:
      `Ya se le mandó una frase de espera en esta conversación y el broker todavía no ` +
      `respondió: el cliente NO recibió nada. Se escaló igual (docs/TASKS.md Bloque 31).`,
  };
}
