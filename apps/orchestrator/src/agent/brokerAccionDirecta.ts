import type { ConversationState } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { AppointmentStore } from "./appointmentStore.js";
import type { ConversationStateStore } from "./conversationStateStore.js";
import { idleState } from "./conversationStateStore.js";
import type { BrokerAccionDirectaPlanner, PlannedAction } from "./brokerAccionDirectaPlan.js";
import type { ConfirmationClassifier } from "./confirmationClassifier.js";
import { executeActionPlan, summarizeExecution, toolsCalledForPlan } from "./brokerAccionDirectaExecutor.js";

export interface BrokerAccionDirectaDeps {
  planner: BrokerAccionDirectaPlanner;
  confirmationClassifier: ConfirmationClassifier;
  gcal: GcalQueries;
  /** Para que el executor resuelva id -> telefono/nombre del lead (docs/TASKS.md Bloque 16). */
  tokko: TokkoQueries;
  appointmentStore: AppointmentStore;
  conversationStateStore: ConversationStateStore;
  /** Sin sender configurado, las acciones de whatsapp del plan fallan (best-effort). */
  sender?: WhatsAppSender;
}

export interface BrokerAccionDirectaStepResult {
  responseText: string;
  toolsCalled: string[];
}

interface BrokerAccionDirectaContext {
  actions: PlannedAction[];
}

/**
 * Primer turno de broker_accion_directa (docs/TASKS.md Bloque 10): Claude
 * arma un plan de acciones concretas a partir de la orden en lenguaje libre
 * (ver brokerAccionDirectaPlan.ts). Si el plan afecta a más de un contacto
 * (`requires_preview_if_bulk` en docs/intent_catalog.yaml), nunca se
 * ejecuta directo: se guarda el plan en el ConversationState del broker y
 * se le pide confirmación explícita (turno 2, `continueBrokerAccionDirecta`
 * más abajo, enganchado en stateMachine.ts). Si es un solo contacto, se
 * ejecuta de una — `requires_client_confirmation: false` en el catálogo es
 * justamente eso: acá el que confirma es el broker, no el cliente.
 *
 * El preview y el resumen de ejecución se arman acá con texto propio, no
 * con el composer (`response.style: generative_grounded` en el catálogo).
 * Es una desviación deliberada: la pregunta de confirmación bulk es
 * seguridad, no redacción — no queremos que una reformulación del LLM
 * pierda el conteo de contactos o la pregunta misma.
 */
export async function runBrokerAccionDirecta(
  message: IncomingWhatsAppMessage,
  deps: BrokerAccionDirectaDeps
): Promise<BrokerAccionDirectaStepResult> {
  const plan = await deps.planner.plan(message.text);

  if (plan.actions.length === 0) {
    return { responseText: plan.previewSummary, toolsCalled: [] };
  }

  const distinctContacts = new Set(plan.actions.map((action) => action.leadId)).size;

  if (distinctContacts > 1) {
    const context: BrokerAccionDirectaContext = { actions: plan.actions };
    await deps.conversationStateStore.save({
      ...idleState(message.from, message.from),
      channel: "broker",
      currentIntentId: "broker_accion_directa",
      step: "esperando_ok_broker",
      context: context as unknown as Record<string, unknown>,
    });
    return {
      responseText: `${plan.previewSummary} Esto le va a llegar a ${distinctContacts} contactos. ¿Confirmás?`,
      toolsCalled: [],
    };
  }

  const results = await executeActionPlan(plan.actions, {
    gcal: deps.gcal,
    tokko: deps.tokko,
    appointmentStore: deps.appointmentStore,
    sender: deps.sender,
  });
  return { responseText: summarizeExecution(results), toolsCalled: toolsCalledForPlan(plan.actions) };
}

/**
 * Segundo turno: el broker ya vio el preview bulk y esta es su respuesta.
 * Cualquier cosa que no sea una confirmación clara aborta sin ejecutar nada
 * (ver ClaudeConfirmationClassifier) — "nunca una acción masiva directo,
 * sin excepción" es la regla dura de este bloque. Chequea `=== true`
 * explícito (no `!confirmed`) a propósito: no confía en que "falsy" siempre
 * signifique "no" — ver más abajo por qué.
 *
 * Si el classifier no puede leer la respuesta (Claude truncado, sin
 * tool_use, etc. — tira una excepción, no vuelve `confirmed: false`), NO
 * se toca el estado: el plan sigue pendiente en `esperando_ok_broker` tal
 * cual estaba, y se le pide al broker que confirme de nuevo. Antes esto se
 * confundía en silencio con un "no" del broker — descubierto en vivo
 * (docs/TASKS.md Bloque 10, 2026-07-28): funcionaba por casualidad (la
 * rama seria la segura) pero no por diseño, y ocultaba el error real.
 */
export async function continueBrokerAccionDirecta(
  message: IncomingWhatsAppMessage,
  state: ConversationState,
  deps: BrokerAccionDirectaDeps
): Promise<BrokerAccionDirectaStepResult> {
  let confirmed: boolean;
  try {
    ({ confirmed } = await deps.confirmationClassifier.extractConfirmation(message.text));
  } catch (error) {
    console.error(
      "broker_accion_directa: no se pudo interpretar la confirmación del broker (el plan queda pendiente, no se ejecuta ni se descarta):",
      error
    );
    return { responseText: "No pude interpretar tu respuesta, confirmame de nuevo.", toolsCalled: [] };
  }

  await deps.conversationStateStore.save(idleState(message.from, message.from));

  if (confirmed !== true) {
    return { responseText: "Ok, no hago nada entonces.", toolsCalled: [] };
  }

  const context = state.context as unknown as BrokerAccionDirectaContext;
  const results = await executeActionPlan(context.actions, {
    gcal: deps.gcal,
    tokko: deps.tokko,
    appointmentStore: deps.appointmentStore,
    sender: deps.sender,
  });
  return { responseText: summarizeExecution(results), toolsCalled: toolsCalledForPlan(context.actions) };
}
