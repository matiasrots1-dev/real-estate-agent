import type { ConversationState, IntentCatalog } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import { findIntent } from "./intentCatalog.js";
import {
  continueAgendarVisita,
  type AgendarVisitaDeps,
  type AgendarVisitaStepResult,
} from "./agendarVisita.js";
import {
  continueReprogramarCancelarVisita,
  type ReprogramarCancelarVisitaDeps,
  type ReprogramarCancelarVisitaStepResult,
} from "./reprogramarCancelarVisita.js";
import { continueBrokerAccionDirecta, type BrokerAccionDirectaDeps } from "./brokerAccionDirecta.js";

/**
 * Máquina de estados de conversación (docs/TASKS.md Bloque 5): soporta los
 * dos flujos multi-turno del catálogo — "quiero agendar visita" → el agente
 * propone horarios → el cliente confirma uno (y lo mismo para reprogramar).
 * `ConversationState.step` (shared-types) es el estado; acá vive la
 * transición: dado el step actual, a qué handler de continuación rutear.
 *
 * Fuera de estos dos flujos no hay más estados que "idle" — el resto de los
 * intents (Bloque 3/4) son de un solo turno y no tocan esta máquina.
 */
export interface ConversationContinuationResult {
  matchedIntentId: string;
  responseText: string;
  toolsCalled: string[];
  escalate: boolean;
  escalationReason?: string;
}

export interface StateMachineDeps {
  catalog: IntentCatalog;
  agendarVisita: AgendarVisitaDeps;
  reprogramarCancelarVisita: ReprogramarCancelarVisitaDeps;
  brokerAccionDirecta: BrokerAccionDirectaDeps;
}

/**
 * Si `state` corresponde a un flujo multi-turno conocido y activo, lo
 * continúa con la respuesta del cliente y devuelve el resultado. Devuelve
 * `null` si el estado no matchea ningún flujo conocido (ej. quedó en un
 * step de una versión vieja del catálogo) — el caller decide qué hacer con
 * un estado inconsistente (hoy: resetear a idle y tratar como mensaje
 * nuevo, ver handleIncomingMessage.ts).
 */
export async function continueConversationIfActive(
  message: IncomingWhatsAppMessage,
  state: ConversationState,
  deps: StateMachineDeps
): Promise<ConversationContinuationResult | null> {
  if (state.currentIntentId === "agendar_visita" && state.step === "esperando_confirmacion_horario") {
    const intent = findIntent(deps.catalog, "agendar_visita");
    if (!intent) return null;
    const result = await continueAgendarVisita(message, state, intent, deps.agendarVisita);
    return toContinuationResult("agendar_visita", result);
  }

  if (
    state.currentIntentId === "reprogramar_cancelar_visita" &&
    state.step === "esperando_confirmacion_reprogramacion"
  ) {
    const intent = findIntent(deps.catalog, "reprogramar_cancelar_visita");
    if (!intent) return null;
    const result = await continueReprogramarCancelarVisita(message, state, intent, deps.reprogramarCancelarVisita);
    return toContinuationResult("reprogramar_cancelar_visita", result);
  }

  if (state.currentIntentId === "broker_accion_directa" && state.step === "esperando_ok_broker") {
    const result = await continueBrokerAccionDirecta(message, state, deps.brokerAccionDirecta);
    return { matchedIntentId: "broker_accion_directa", ...result, escalate: false };
  }

  return null;
}

function toContinuationResult(
  matchedIntentId: string,
  result: AgendarVisitaStepResult | ReprogramarCancelarVisitaStepResult
): ConversationContinuationResult {
  return { matchedIntentId, ...result };
}
