import type { Intent } from "shared-types";
import type { ConversationStateStore } from "./conversationStateStore.js";
import { idleState } from "./conversationStateStore.js";
import type { GlobalPauseStore } from "./globalPauseStore.js";
import type { PausarAgenteActionClassifier } from "./pausarAgenteClassifier.js";

export interface BrokerPausarAgenteResult {
  responseText: string;
  toolsCalled: string[];
}

export interface BrokerPausarAgenteDeps {
  conversationStateStore: ConversationStateStore;
  globalPauseStore: GlobalPauseStore;
  pausarAgenteActionClassifier: PausarAgenteActionClassifier;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

/**
 * docs/intent_catalog.yaml: broker_pausar_agente (canal broker). El alcance
 * "global" pausa/reactiva para todos los clientes (`GlobalPauseStore`); el
 * alcance "conversacion" necesita el teléfono del cliente puntual — si el
 * broker solo dio un nombre, no adivinamos: se lo pedimos de vuelta en vez
 * de arriesgarnos a pausar (o dejar de pausar) la conversación equivocada.
 */
export async function runBrokerPausarAgente(
  message: string,
  intent: Intent,
  deps: BrokerPausarAgenteDeps
): Promise<BrokerPausarAgenteResult> {
  const action = await deps.pausarAgenteActionClassifier.extractAction(message);
  const template = intent.response.template ?? "Listo, {accion} para {alcance}.";
  const accionLabel = action.accion === "pausar" ? "pausé el agente" : "reactivé el agente";

  if (action.alcance === "global") {
    await deps.globalPauseStore.setPaused(action.accion === "pausar");
    return {
      responseText: renderTemplate(template, { accion: accionLabel, alcance: "todas las conversaciones" }).trim(),
      toolsCalled: ["state.set_global_flag"],
    };
  }

  if (!action.telefonoCliente) {
    return {
      responseText:
        "No pude identificar a qué cliente te referís — pasame el número de teléfono y lo pauso puntualmente.",
      toolsCalled: [],
    };
  }

  const existing =
    (await deps.conversationStateStore.get(action.telefonoCliente)) ??
    idleState(action.telefonoCliente, action.telefonoCliente);
  await deps.conversationStateStore.save({
    ...existing,
    pausedByBroker: action.accion === "pausar",
    updatedAt: new Date().toISOString(),
  });

  return {
    responseText: renderTemplate(template, {
      accion: accionLabel,
      alcance: `la conversación con ${action.telefonoCliente}`,
    }).trim(),
    toolsCalled: ["state.set_conversation_flag"],
  };
}
