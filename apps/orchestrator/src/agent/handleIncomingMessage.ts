import { randomUUID } from "node:crypto";
import type { AuditLogEntry, ConversationState, Intent, IntentCatalog } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { WeatherQueries } from "../mcp/weatherMcpClient.js";
import { effectiveConfidenceThreshold, filterCatalogByChannel, findIntent } from "./intentCatalog.js";
import type { ContextoConversacion, IntentClassifier } from "./classifier.js";
import type { UltimoContactoStore } from "./ultimoContactoStore.js";
import type { UltimoContacto } from "./ultimoContactoStore.js";
import {
  decidirPlantilla,
  plantillasFijas,
  type DecisionPlantilla,
} from "./plantillaRepetida.js";
import type { ResponseComposer } from "./composer.js";
import type { DraftReplyComposer } from "./draftComposer.js";
import type { BrokerNotifier } from "./brokerNotifier.js";
import type { AuditLogStore } from "./auditLog.js";
import { colapsarPorMensaje } from "./auditPorMensaje.js";
import { describirError } from "./registroDeLlegada.js";
import type { AppointmentStore } from "./appointmentStore.js";
import type { ConversationStateStore } from "./conversationStateStore.js";
import { idleState } from "./conversationStateStore.js";
import type { SlotConfirmationClassifier } from "./slotConfirmation.js";
import type { ReprogramActionClassifier } from "./reprogramActionClassifier.js";
import { decideEscalation, type EscalationRule } from "./escalation.js";
import { runConsultaDisponibilidad } from "./consultaDisponibilidad.js";
import { runConsultaPrecioCondiciones } from "./consultaPrecioCondiciones.js";
import { runPedidoFichaMultimedia } from "./pedidoFichaMultimedia.js";
import { runConsultaClimaVisita } from "./consultaClimaVisita.js";
import { startAgendarVisita, type AgendarVisitaDeps, type AgendarVisitaStepResult } from "./agendarVisita.js";
import {
  startReprogramarCancelarVisita,
  type ReprogramarCancelarVisitaDeps,
  type ReprogramarCancelarVisitaStepResult,
} from "./reprogramarCancelarVisita.js";
import { continueConversationIfActive } from "./stateMachine.js";
import { runBrokerResumenAgenda } from "./brokerResumenAgenda.js";
import { runBrokerResumenLeads } from "./brokerResumenLeads.js";
import { runBrokerPausarAgente } from "./brokerPausarAgente.js";
import type { GlobalPauseStore } from "./globalPauseStore.js";
import type { LastInteractionStore } from "./lastInteractionStore.js";
import type { PausarAgenteActionClassifier } from "./pausarAgenteClassifier.js";
import { runBrokerAccionDirecta, type BrokerAccionDirectaDeps } from "./brokerAccionDirecta.js";
import type { BrokerAccionDirectaPlanner } from "./brokerAccionDirectaPlan.js";
import type { ConfirmationClassifier } from "./confirmationClassifier.js";

/** No es un id real del catálogo — marca en `audit_log` los mensajes que se recibieron pero no se procesaron por pausa (docs/TASKS.md Bloque 9). */
const PAUSED_SENTINEL_INTENT_ID = "agente_pausado";

/**
 * El intent matcheó pero no hay handler para él: ni escala, ni es uno de los
 * intents reactivos implementados (docs/TASKS.md Bloque 3-5), ni un flujo
 * multi-turno conocido. Cubre por ahora los intents de canal broker y los
 * de tipo `scheduled` (fase 2, fuera de alcance). Se lanza en vez de
 * improvisar una respuesta — server.ts la atrapa y no manda nada al cliente.
 */
export class NotImplementedIntentError extends Error {
  constructor(public readonly intentId: string) {
    super(`Intent "${intentId}" matcheado pero sin handler implementado todavía.`);
    this.name = "NotImplementedIntentError";
  }
}

/**
 * Lee de una sola pasada lo que necesitan el contexto del clasificador y la
 * supresion de plantilla repetida: las entradas de esta conversacion y el
 * ultimo contacto del broker.
 *
 * Devuelve `null` si la lectura falla. Los dos consumidores lo interpretan
 * distinto a proposito, porque el costo de equivocarse es distinto en cada
 * uno (ver `armarContexto` y `decidirEnvioDePlantilla`).
 */
async function leerHistorial(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage
): Promise<{ entradas: AuditLogEntry[]; ultimoContacto: UltimoContacto | null } | null> {
  try {
    const entradas: AuditLogEntry[] = [];
    // Una entrada por mensaje (docs/TASKS.md Bloque 34): cada mensaje deja una
    // `recibido` y la que lo resuelve, y sin colapsar el clasificador vería
    // cada mensaje anterior dos veces.
    for (const entrada of colapsarPorMensaje(await deps.auditLog.readAll())) {
      // Igualdad EXACTA del conversationId, nunca comparacion canonica: un
      // match flojo mezclaria el hilo de dos personas distintas y el
      // clasificador leeria la conversacion de otro (docs/TASKS.md Bloque 17,
      // el leadId inconsistente).
      if (entrada.conversationId !== message.from) continue;
      // El mensaje actual ya está en el audit log: su `recibido` se escribe
      // antes de encolar. Sin este filtro el clasificador lo vería como si
      // fuera un mensaje anterior de la misma persona.
      if (entrada.messageId === message.messageId) continue;
      // Un `recibido` sin resolver de esta conversación es, casi siempre, un
      // mensaje POSTERIOR que espera en la cola detrás de este: la cola es
      // serial por conversación, así que los anteriores ya se resolvieron.
      // Si entrara, el clasificador leería el futuro como si fuera el mensaje
      // más reciente. Los `fallido` sí entran: el cliente los escribió antes.
      if (entrada.etapa === "recibido") continue;
      entradas.push(entrada);
    }
    const ultimoContacto = (await deps.ultimoContactoStore?.get(message.from)) ?? null;
    return { entradas, ultimoContacto };
  } catch (error) {
    console.warn("No se pudo leer el historial de la conversacion:", error);
    return null;
  }
}

/**
 * Arma el hilo de la conversacion para el clasificador.
 *
 * Un fallo aca no puede tumbar el mensaje: si el historial no se pudo leer se
 * clasifica sin contexto, que es exactamente lo que se hacia antes. Peor
 * clasificacion es aceptable; perder el mensaje no.
 */
function armarContexto(
  historial: { entradas: AuditLogEntry[]; ultimoContacto: UltimoContacto | null } | null,
  ahora: Date
): ContextoConversacion | undefined {
  if (!historial) return undefined;

  const previos: string[] = [];
  for (const entrada of historial.entradas) {
    if (entrada.incomingMessage) previos.push(entrada.incomingMessage);
  }

  let horasDesdeContactoDelBroker: number | undefined;
  if (historial.ultimoContacto) {
    const ms = ahora.getTime() - new Date(historial.ultimoContacto.contactadoAt).getTime();
    // Solo se informa si es reciente: que el broker haya escrito hace tres
    // meses no ayuda a interpretar el mensaje de hoy, y meterlo en el prompt
    // solo agrega ruido.
    if (ms >= 0 && ms <= 7 * 24 * 3600 * 1000) horasDesdeContactoDelBroker = ms / 3_600_000;
  }

  if (previos.length === 0 && horasDesdeContactoDelBroker === undefined) return undefined;
  return { mensajesPrevios: previos, horasDesdeContactoDelBroker };
}

/**
 * Decide si la plantilla fija sale o se suprime (docs/TASKS.md Bloque 31).
 *
 * **Falla cerrado**: si el historial no se pudo leer, se suprime. Decision del
 * dueno del repo — 16 repeticiones de la misma frase es peor que el silencio,
 * asi que ante la duda no se manda. El costo es perder una plantilla legitima
 * en el caso raro de que el audit log no se pueda leer.
 */
function decidirEnvioDePlantilla(
  deps: HandleMessageDeps,
  intentId: string,
  historial: { entradas: AuditLogEntry[]; ultimoContacto: UltimoContacto | null } | null,
  ahora: Date
): DecisionPlantilla {
  const fijas = plantillasFijas(deps.catalog);
  if (!fijas.has(intentId)) return { suprimir: false };
  if (!historial) {
    return {
      suprimir: true,
      motivo:
        "No se pudo leer el historial para saber si la plantilla ya se habia enviado; " +
        "se suprime por las dudas. El cliente NO recibio nada (docs/TASKS.md Bloque 31).",
    };
  }
  return decidirPlantilla({
    intentId,
    fijas,
    historial: historial.entradas,
    ultimoContacto: historial.ultimoContacto,
    ahora,
  });
}

/**
 * El mensaje viene del broker. **Una sola definición** para el ruteo por canal
 * y para el modo silencioso (docs/TASKS.md Bloque 38g): si las dos decidieran
 * por separado, una orden del broker podría rutearse como del broker y
 * silenciarse como de un cliente.
 */
function esDelBroker(deps: HandleMessageDeps, message: IncomingWhatsAppMessage): boolean {
  return deps.brokerWhatsappNumber !== undefined && message.from === deps.brokerWhatsappNumber;
}

/**
 * El modo silencioso calla lo que va a los **clientes**. Las respuestas a las
 * órdenes del broker salen igual (docs/TASKS.md Bloque 38g): antes, en modo
 * silencioso, el broker pedía un resumen y recibía un "Escalamiento" con un
 * borrador sobre su propio mensaje. `SilentModeSender` deja pasar los envíos
 * al broker, así que la respuesta llega.
 */
function silenciarPara(deps: HandleMessageDeps, message: IncomingWhatsAppMessage): boolean {
  return deps.modoSilencioso === true && !esDelBroker(deps, message);
}

/** Motivo que se registra en el audit log y se le manda al broker en modo silencioso. */
const MOTIVO_SILENCIOSO =
  "Modo silencioso activo: el cliente NO recibió respuesta. Respondele vos a mano.";

export interface HandleMessageDeps {
  catalog: IntentCatalog;
  classifier: IntentClassifier;
  composer: ResponseComposer;
  draftComposer: DraftReplyComposer;
  tokko: TokkoQueries;
  gcal: GcalQueries;
  weather: WeatherQueries;
  auditLog: AuditLogStore;
  appointmentStore: AppointmentStore;
  conversationStateStore: ConversationStateStore;
  slotConfirmationClassifier: SlotConfirmationClassifier;
  reprogramActionClassifier: ReprogramActionClassifier;
  globalPauseStore: GlobalPauseStore;
  pausarAgenteActionClassifier: PausarAgenteActionClassifier;
  /** Registra cuándo interactuó por última vez cada lead — alimenta el purgado por retención (docs/TASKS.md Bloque 15). */
  lastInteractionStore: LastInteractionStore;
  brokerAccionDirectaPlanner: BrokerAccionDirectaPlanner;
  confirmationClassifier: ConfirmationClassifier;
  defaultLat: number;
  defaultLng: number;
  /** Si no está configurado, se escala igual pero no se notifica a nadie. */
  brokerNotifier?: BrokerNotifier;
  /** Si `message.from` matchea esto, el mensaje es del canal `broker`, no `cliente` (docs/TASKS.md Bloque 8). */
  brokerWhatsappNumber?: string;
  /** Sin esto, broker_accion_directa igual arma el plan pero las acciones de whatsapp del plan fallan (best-effort). */
  sender?: WhatsAppSender;
  /**
   * Modo silencioso (docs/TASKS.md Bloque 21): se recibe, se clasifica y se le
   * manda **siempre** el borrador al broker, pero al cliente **no se le
   * responde nada**. Prendido por default.
   *
   * No es lo mismo que la pausa del Bloque 9: la pausa corta antes de
   * clasificar y no notifica a nadie. Acá el trabajo se hace completo, lo
   * único que no ocurre es el envío al cliente.
   */
  modoSilencioso?: boolean;
  /**
   * Para saber si el broker le escribió a esta persona y hace cuánto. Es el
   * contexto que más aporta: convierte "recordame el link" de inclasificable
   * en un pedido de ficha en respuesta a un contacto.
   */
  ultimoContactoStore?: UltimoContactoStore;
}

export interface HandleMessageResult {
  /** `null` cuando el agente está pausado para este cliente (docs/TASKS.md Bloque 9) — no hay nada que mandar. */
  responseText: string | null;
  intentId: string;
  confidence: number | null;
  escalatedToBroker: boolean;
  /** Solo pedido_ficha_multimedia lo usa hoy. */
  mediaUrls?: string[];
}

export async function handleIncomingMessage(
  message: IncomingWhatsAppMessage,
  deps: HandleMessageDeps
): Promise<HandleMessageResult> {
  // docs/TASKS.md Bloque 8: el classifier solo ve los intents del canal que
  // corresponde — un cliente nunca puede matchear un intent `channel:
  // broker` ni viceversa. Nota conocida: esto asume que `message.from`
  // llega exactamente igual a `BROKER_WHATSAPP_NUMBER`; Meta a veces
  // normaliza números argentinos de forma inconsistente (ver Bloque 4/6),
  // así que un desfasaje de formato haría que el broker sea tratado como
  // cliente en vez de fallar ruidosamente — a revisar con uso real.
  const channel = esDelBroker(deps, message) ? "broker" : "cliente";

  // Un mensaje entrante del cliente es una interacción suya, y eso define
  // cuánto se retienen sus datos de gestión comercial (docs/TASKS.md Bloque
  // 15). Se registra antes del gate de pausa a propósito: que el broker haya
  // pausado el agente no significa que el cliente dejó de estar activo.
  // Los mensajes del broker no cuentan — él no es un lead.
  if (channel === "cliente") {
    await deps.lastInteractionStore.record(message.from, new Date());
  }

  const state = (await deps.conversationStateStore.get(message.from)) ?? idleState(message.from, message.from);

  // docs/TASKS.md Bloque 9: la pausa (puntual o global) corta el flujo antes
  // de gastar ninguna llamada a Claude — ni el classifier del mensaje nuevo
  // ni el clasificador de continuación de un flujo multi-turno ya en curso.
  // Nunca aplica al canal broker: el broker siempre tiene que poder hablar
  // con el agente, aunque sea para reactivarlo.
  if (channel === "cliente" && (state.pausedByBroker || (await deps.globalPauseStore.isPaused()))) {
    await appendAudit(deps, message, PAUSED_SENTINEL_INTENT_ID, null, [], false);
    return { responseText: null, intentId: PAUSED_SENTINEL_INTENT_ID, confidence: null, escalatedToBroker: false };
  }

  if (state.step !== "idle" && state.currentIntentId) {
    const continuation = await continueConversationIfActive(message, state, {
      catalog: deps.catalog,
      agendarVisita: agendarVisitaDeps(deps, deps.catalog.meta.language),
      reprogramarCancelarVisita: reprogramarVisitaDeps(deps),
      brokerAccionDirecta: brokerAccionDirectaDeps(deps),
    });
    if (continuation) {
      const intent = findIntent(deps.catalog, continuation.matchedIntentId);
      if (intent) {
        return finalizeVisitStep(deps, message, intent, null, continuation);
      }
    }
    // Estado inconsistente (ej. el catálogo cambió, o quedó un step sin
    // handler conocido): reseteamos a idle y tratamos el mensaje como nuevo
    // en vez de quedar la conversación trabada para siempre.
    await deps.conversationStateStore.save(idleState(message.from, message.from));
  }

  const catalogForChannel = filterCatalogByChannel(deps.catalog, channel);

  const ahora = new Date();
  const historial = await leerHistorial(deps, message);
  const contexto = armarContexto(historial, ahora);
  const classification = await deps.classifier.classify(message.text, catalogForChannel, contexto);
  const intent = findIntent(deps.catalog, classification.intentId);
  if (!intent) {
    throw new NotImplementedIntentError(classification.intentId);
  }

  const threshold = effectiveConfidenceThreshold(deps.catalog, intent);
  const decision = decideEscalation(intent, classification.confidence, threshold);

  if (decision.shouldEscalate) {
    const responseText = intent.response.template ?? "Dejame confirmarlo con el asesor y te respondo enseguida.";
    const plantilla = decidirEnvioDePlantilla(deps, intent.id, historial, ahora);
    return finalizeEscalation(
      deps,
      message,
      intent,
      classification.confidence,
      [],
      responseText,
      decision.rule,
      decision.reason,
      plantilla
    );
  }

  const language = deps.catalog.meta.language;

  switch (intent.id) {
    case "consulta_disponibilidad": {
      const result = await runConsultaDisponibilidad(classification, intent, deps.tokko, deps.composer, language);
      return finalizeNonEscalating(deps, message, intent, classification.confidence, result.toolsCalled, result.responseText);
    }

    case "consulta_precio_condiciones": {
      const result = await runConsultaPrecioCondiciones(classification, intent, deps.tokko, deps.composer, language);
      return finalizeNonEscalating(deps, message, intent, classification.confidence, result.toolsCalled, result.responseText);
    }

    case "pedido_ficha_multimedia": {
      const result = await runPedidoFichaMultimedia(classification, intent, deps.tokko);
      return finalizeNonEscalating(
        deps,
        message,
        intent,
        classification.confidence,
        result.toolsCalled,
        result.responseText,
        result.mediaUrls.length > 0 ? result.mediaUrls : undefined
      );
    }

    case "consulta_clima_visita": {
      const result = await runConsultaClimaVisita(message.from, intent, {
        appointmentStore: deps.appointmentStore,
        gcal: deps.gcal,
        tokko: deps.tokko,
        weather: deps.weather,
        composer: deps.composer,
        language,
        defaultLat: deps.defaultLat,
        defaultLng: deps.defaultLng,
      });
      return finalizeNonEscalating(deps, message, intent, classification.confidence, result.toolsCalled, result.responseText);
    }

    case "agendar_visita": {
      const result = await startAgendarVisita(message, classification, intent, agendarVisitaDeps(deps, language));
      return finalizeVisitStep(deps, message, intent, classification.confidence, result);
    }

    case "reprogramar_cancelar_visita": {
      const result = await startReprogramarCancelarVisita(message, intent, reprogramarVisitaDeps(deps));
      return finalizeVisitStep(deps, message, intent, classification.confidence, result);
    }

    case "broker_resumen_agenda": {
      const result = await runBrokerResumenAgenda(intent, {
        gcal: deps.gcal,
        tokko: deps.tokko,
        appointmentStore: deps.appointmentStore,
        composer: deps.composer,
        language,
      });
      return finalizeNonEscalating(deps, message, intent, classification.confidence, result.toolsCalled, result.responseText);
    }

    case "broker_resumen_leads": {
      const result = await runBrokerResumenLeads(intent, deps.tokko, deps.composer, language);
      return finalizeNonEscalating(deps, message, intent, classification.confidence, result.toolsCalled, result.responseText);
    }

    case "broker_pausar_agente": {
      const result = await runBrokerPausarAgente(message.text, intent, {
        conversationStateStore: deps.conversationStateStore,
        globalPauseStore: deps.globalPauseStore,
        pausarAgenteActionClassifier: deps.pausarAgenteActionClassifier,
      });
      return finalizeNonEscalating(deps, message, intent, classification.confidence, result.toolsCalled, result.responseText);
    }

    case "broker_accion_directa": {
      const result = await runBrokerAccionDirecta(message, brokerAccionDirectaDeps(deps));
      return finalizeNonEscalating(deps, message, intent, classification.confidence, result.toolsCalled, result.responseText);
    }

    default:
      throw new NotImplementedIntentError(intent.id);
  }
}

function agendarVisitaDeps(deps: HandleMessageDeps, language: string): AgendarVisitaDeps {
  return {
    tokko: deps.tokko,
    gcal: deps.gcal,
    conversationStateStore: deps.conversationStateStore,
    appointmentStore: deps.appointmentStore,
    composer: deps.composer,
    slotConfirmationClassifier: deps.slotConfirmationClassifier,
    language,
  };
}

function reprogramarVisitaDeps(deps: HandleMessageDeps): ReprogramarCancelarVisitaDeps {
  return {
    tokko: deps.tokko,
    gcal: deps.gcal,
    conversationStateStore: deps.conversationStateStore,
    appointmentStore: deps.appointmentStore,
    slotConfirmationClassifier: deps.slotConfirmationClassifier,
    reprogramActionClassifier: deps.reprogramActionClassifier,
  };
}

function brokerAccionDirectaDeps(deps: HandleMessageDeps): BrokerAccionDirectaDeps {
  return {
    planner: deps.brokerAccionDirectaPlanner,
    confirmationClassifier: deps.confirmationClassifier,
    gcal: deps.gcal,
    tokko: deps.tokko,
    appointmentStore: deps.appointmentStore,
    conversationStateStore: deps.conversationStateStore,
    sender: deps.sender,
  };
}

/** agendar_visita y reprogramar_cancelar_visita pueden escalar en runtime (sin slots, o el cliente no eligió ninguno). */
async function finalizeVisitStep(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage,
  intent: Intent,
  confidence: number | null,
  result: AgendarVisitaStepResult | ReprogramarCancelarVisitaStepResult
): Promise<HandleMessageResult> {
  if (result.escalate) {
    return finalizeEscalation(
      deps,
      message,
      intent,
      confidence,
      result.toolsCalled,
      result.responseText,
      "requires_broker",
      result.escalationReason
    );
  }
  return finalizeNonEscalating(deps, message, intent, confidence, result.toolsCalled, result.responseText);
}

async function finalizeNonEscalating(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage,
  intent: Intent,
  confidence: number | null,
  toolsCalled: string[],
  responseText: string,
  mediaUrls?: string[]
): Promise<HandleMessageResult> {
  // Modo silencioso: el cliente no recibe nada, pero el broker sí tiene que
  // enterarse. Sin esto el mensaje se perdería en silencio para todos — peor
  // que el problema que el modo silencioso vino a resolver.
  if (silenciarPara(deps, message)) {
    // La respuesta que el bot habría mandado va como respaldo del borrador:
    // si Claude no puede redactarlo, el broker recibe esa en vez de nada.
    const aviso = await notifyBrokerBestEffort(deps, message, intent, confidence, MOTIVO_SILENCIOSO, responseText);
    // `responseSent: undefined` a propósito: no se envió nada, y el audit log
    // no puede decir lo contrario. Es el registro que se usa para reconstruir
    // qué recibió cada persona.
    await appendAudit(deps, message, intent.id, confidence, toolsCalled, false, {
      escalationReason: MOTIVO_SILENCIOSO,
      aviso,
    });
    return { responseText: null, intentId: intent.id, confidence, escalatedToBroker: false };
  }

  await appendAudit(deps, message, intent.id, confidence, toolsCalled, false, { responseSent: responseText });
  return { responseText, intentId: intent.id, confidence, escalatedToBroker: false, mediaUrls };
}

async function finalizeEscalation(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage,
  intent: Intent,
  confidence: number | null,
  toolsCalled: string[],
  responseText: string,
  rule: EscalationRule | undefined,
  reason: string | undefined,
  /**
   * Supresion de plantilla repetida (docs/TASKS.md Bloque 31). Los caminos
   * que no producen una plantilla fija del catalogo no la pasan: `intentId`
   * no estaria en el conjunto y la decision seria la misma.
   */
  plantilla: DecisionPlantilla = { suprimir: false }
): Promise<HandleMessageResult> {
  // El broker se entera SIEMPRE, se le responda al cliente o no. Es lo que
  // separa "el agente se calla" de "el mensaje se pierde".
  const aviso = await notifyBrokerBestEffort(deps, message, intent, confidence, reason);

  // La plantilla ya salio en esta conversacion y el broker todavia no
  // contesto: se escalo igual, pero al cliente no le llega otra copia de la
  // misma frase. `responseSent` sin cargar a proposito — el audit log es el
  // registro de que recibio cada persona y no puede decir que se envio algo
  // que no se envio.
  const silencio = silenciarPara(deps, message);
  if (plantilla.suprimir && !silencio) {
    await appendAudit(deps, message, intent.id, confidence, toolsCalled, true, {
      escalationRule: rule,
      escalationReason: plantilla.motivo,
      aviso,
    });
    return { responseText: null, intentId: intent.id, confidence, escalatedToBroker: true };
  }

  if (silencio) {
    // Ya escalaba y ya notificaba al broker; lo único que cambia es que la
    // plantilla de espera tampoco sale.
    await appendAudit(deps, message, intent.id, confidence, toolsCalled, true, {
      escalationRule: rule,
      escalationReason: reason,
      aviso,
    });
    return { responseText: null, intentId: intent.id, confidence, escalatedToBroker: true };
  }
  await appendAudit(deps, message, intent.id, confidence, toolsCalled, true, {
    escalationRule: rule,
    escalationReason: reason,
    responseSent: responseText,
    aviso,
  });
  return { responseText, intentId: intent.id, confidence, escalatedToBroker: true };
}

/**
 * Lo opcional de una entrada, por nombre y no por posición: `escalationReason`
 * y `responseSent` son los dos `string | undefined`, e intercambiarlos
 * compilaría igual y registraría como enviada una respuesta que no salió.
 */
interface ExtrasDeAuditoria {
  escalationRule?: EscalationRule;
  escalationReason?: string;
  /** Lo que efectivamente recibió el cliente. Sin cargar si no recibió nada. */
  responseSent?: string;
  aviso?: ResultadoDelAviso;
}

async function appendAudit(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage,
  intentId: string,
  confidence: number | null,
  toolsCalled: string[],
  escalatedToBroker: boolean,
  extras: ExtrasDeAuditoria = {}
): Promise<void> {
  const entry: AuditLogEntry = {
    id: randomUUID(),
    conversationId: message.from,
    timestamp: new Date().toISOString(),
    incomingMessage: message.text,
    matchedIntentId: intentId,
    confidence,
    toolsCalled,
    escalatedToBroker,
    escalationRule: extras.escalationRule,
    escalationReason: extras.escalationReason,
    responseSent: extras.responseSent,
    // Vincula esta entrada con la `recibido` del mismo mensaje, que se escribió
    // al llegar (docs/TASKS.md Bloque 34).
    messageId: message.messageId,
    avisoAlBroker: extras.aviso?.estado,
    avisoAlBrokerMotivo: extras.aviso?.motivo,
  };
  await deps.auditLog.append(entry);
}

interface ResultadoDelAviso {
  estado: NonNullable<AuditLogEntry["avisoAlBroker"]>;
  /** Por qué falló el borrador o el aviso. */
  motivo?: string;
}

/**
 * Avisa al broker con un borrador. **Nunca tira**: un fallo del aviso no
 * puede hacer fallar el mensaje (docs/TASKS.md Bloque 38a). Si tirara, el
 * mensaje pasaría a `fallido` y el aviso de fallos del Bloque 34 mandaría otro
 * aviso por el mismo canal que acaba de fallar.
 *
 * El borrador y el aviso van separados: el borrador es una llamada a Claude
 * distinta del clasificador y puede fallar sola (sobrecarga, rate limit).
 * Antes iban en el mismo `try`, y si fallaba el borrador no salía nada. Si
 * falla y hay `respaldo` (la respuesta que el bot habría mandado), va esa.
 *
 * Devuelve qué pasó, para el audit log.
 */
async function notifyBrokerBestEffort(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage,
  intent: Intent,
  confidence: number | null,
  escalationReason: string | undefined,
  respaldo?: string
): Promise<ResultadoDelAviso> {
  if (!deps.brokerNotifier) return { estado: "sin_destinatario" };

  let draftReply: string | null = null;
  let motivoFalloBorrador: string | undefined;
  try {
    const borrador = await deps.draftComposer.composeDraft(message.text, intent.description);
    // Un borrador vacío no se distingue de "no tenía nada que sugerir".
    if (!borrador.trim()) throw new Error("Claude devolvió un borrador vacío");
    draftReply = borrador;
  } catch (error) {
    motivoFalloBorrador = describirError(error);
    console.error("No se pudo redactar el borrador; el aviso al broker sale sin él:", error);
    if (respaldo?.trim()) draftReply = respaldo;
  }

  try {
    await deps.brokerNotifier.notify({
      conversationId: message.from,
      incomingMessage: message.text,
      matchedIntentId: intent.id,
      confidence,
      escalationReason,
      draftReply,
      motivoFalloBorrador,
    });
  } catch (error) {
    console.error("No se pudo mandar el aviso al broker: no se enteró por WhatsApp de este mensaje:", error);
    return { estado: "fallo", motivo: describirError(error) };
  }
  if (motivoFalloBorrador === undefined) return { estado: "enviado" };
  return { estado: draftReply === null ? "sin_borrador" : "respaldo", motivo: motivoFalloBorrador };
}
