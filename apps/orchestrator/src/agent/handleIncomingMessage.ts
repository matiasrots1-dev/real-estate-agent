import { randomUUID } from "node:crypto";
import type { AuditLogEntry, ConversationState, Intent, IntentCatalog } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { WeatherQueries } from "../mcp/weatherMcpClient.js";
import { effectiveConfidenceThreshold, filterCatalogByChannel, findIntent } from "./intentCatalog.js";
import type { IntentClassifier } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { DraftReplyComposer } from "./draftComposer.js";
import type { BrokerNotifier } from "./brokerNotifier.js";
import type { AuditLogStore } from "./auditLog.js";
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
  defaultLat: number;
  defaultLng: number;
  /** Si no está configurado, se escala igual pero no se notifica a nadie. */
  brokerNotifier?: BrokerNotifier;
  /** Si `message.from` matchea esto, el mensaje es del canal `broker`, no `cliente` (docs/TASKS.md Bloque 8). */
  brokerWhatsappNumber?: string;
}

export interface HandleMessageResult {
  responseText: string;
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
  const state = (await deps.conversationStateStore.get(message.from)) ?? idleState(message.from, message.from);

  if (state.step !== "idle" && state.currentIntentId) {
    const continuation = await continueConversationIfActive(message, state, {
      catalog: deps.catalog,
      agendarVisita: agendarVisitaDeps(deps, deps.catalog.meta.language),
      reprogramarCancelarVisita: reprogramarVisitaDeps(deps),
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

  // docs/TASKS.md Bloque 8: el classifier solo ve los intents del canal que
  // corresponde — un cliente nunca puede matchear un intent `channel:
  // broker` ni viceversa. Nota conocida: esto asume que `message.from`
  // llega exactamente igual a `BROKER_WHATSAPP_NUMBER`; Meta a veces
  // normaliza números argentinos de forma inconsistente (ver Bloque 4/6),
  // así que un desfasaje de formato haría que el broker sea tratado como
  // cliente en vez de fallar ruidosamente — a revisar con uso real.
  const channel = message.from === deps.brokerWhatsappNumber ? "broker" : "cliente";
  const catalogForChannel = filterCatalogByChannel(deps.catalog, channel);

  const classification = await deps.classifier.classify(message.text, catalogForChannel);
  const intent = findIntent(deps.catalog, classification.intentId);
  if (!intent) {
    throw new NotImplementedIntentError(classification.intentId);
  }

  const threshold = effectiveConfidenceThreshold(deps.catalog, intent);
  const decision = decideEscalation(intent, classification.confidence, threshold);

  if (decision.shouldEscalate) {
    const responseText = intent.response.template ?? "Dejame confirmarlo con el asesor y te respondo enseguida.";
    return finalizeEscalation(deps, message, intent, classification.confidence, [], responseText, decision.rule, decision.reason);
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
  await appendAudit(deps, message, intent.id, confidence, toolsCalled, false, undefined, undefined, responseText);
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
  reason: string | undefined
): Promise<HandleMessageResult> {
  await notifyBrokerBestEffort(deps, message, intent, confidence, reason);
  await appendAudit(deps, message, intent.id, confidence, toolsCalled, true, rule, reason, responseText);
  return { responseText, intentId: intent.id, confidence, escalatedToBroker: true };
}

async function appendAudit(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage,
  intentId: string,
  confidence: number | null,
  toolsCalled: string[],
  escalatedToBroker: boolean,
  escalationRule: EscalationRule | undefined,
  escalationReason: string | undefined,
  responseText: string
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
    escalationRule,
    escalationReason,
    responseSent: responseText,
  };
  await deps.auditLog.append(entry);
}

async function notifyBrokerBestEffort(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage,
  intent: Intent,
  confidence: number | null,
  escalationReason: string | undefined
): Promise<void> {
  if (!deps.brokerNotifier) return;
  try {
    const draftReply = await deps.draftComposer.composeDraft(message.text, intent.description);
    await deps.brokerNotifier.notify({
      conversationId: message.from,
      incomingMessage: message.text,
      matchedIntentId: intent.id,
      confidence,
      escalationReason,
      draftReply,
    });
  } catch (error) {
    console.error("No se pudo notificar al broker (el cliente igual recibe su respuesta):", error);
  }
}
