import { randomUUID } from "node:crypto";
import type { ConversationState, Intent } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { IntentClassification } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { SlotConfirmationClassifier } from "./slotConfirmation.js";
import type { AppointmentStore } from "./appointmentStore.js";
import type { ConversationStateStore } from "./conversationStateStore.js";
import { idleState } from "./conversationStateStore.js";
import { findPropertyByQuery } from "./tokkoLookup.js";
import { formatSlotForHuman, proposeAvailableSlots, type ProposedSlot } from "./slotProposal.js";

const NOT_FOUND_FALLBACK = "¿Qué propiedad querés visitar? Pasame la dirección o el link del aviso.";
const DEFAULT_ESCALATION_TEXT = "Dejame confirmarlo con el asesor y te respondo enseguida.";

export interface AgendarVisitaDeps {
  tokko: TokkoQueries;
  gcal: GcalQueries;
  conversationStateStore: ConversationStateStore;
  appointmentStore: AppointmentStore;
  composer: ResponseComposer;
  slotConfirmationClassifier: SlotConfirmationClassifier;
  language: string;
}

export interface AgendarVisitaStepResult {
  responseText: string;
  toolsCalled: string[];
  escalate: boolean;
  escalationReason?: string;
}

interface AgendarVisitaContext {
  propertyId: string;
  proposedSlots: ProposedSlot[];
  proposedLabels: string[];
}

/**
 * Primer turno de agendar_visita (docs/intent_catalog.yaml): busca la
 * propiedad, propone hasta 3 horarios libres en las próximas 72hs (horario
 * habitual, sin domingos), y deja la conversación esperando que el cliente
 * elija uno. No crea el evento todavía — `requires_client_confirmation: true`.
 */
export async function startAgendarVisita(
  message: IncomingWhatsAppMessage,
  classification: IntentClassification,
  intent: Intent,
  deps: AgendarVisitaDeps
): Promise<AgendarVisitaStepResult> {
  const { property, toolsCalled } = await findPropertyByQuery(deps.tokko, classification.searchQuery);
  if (!property) {
    return { responseText: NOT_FOUND_FALLBACK, toolsCalled, escalate: false };
  }

  const { slots, toolsCalled: slotTools } = await proposeAvailableSlots(
    deps.gcal,
    new Date().toISOString()
  );
  toolsCalled.push(...slotTools);

  if (slots.length === 0) {
    return {
      responseText: intent.response.template ?? DEFAULT_ESCALATION_TEXT,
      toolsCalled,
      escalate: true,
      escalationReason: intent.escalation_reason,
    };
  }

  const proposedLabels = slots.map((slot) => formatSlotForHuman(slot.startDateTime));
  const responseText = await deps.composer.compose({
    intentDescription: intent.description,
    groundingData: { horarios_disponibles: proposedLabels },
    language: deps.language,
  });

  const context: AgendarVisitaContext = { propertyId: property.id, proposedSlots: slots, proposedLabels };
  await deps.conversationStateStore.save({
    conversationId: message.from,
    channel: "cliente",
    phoneNumber: message.from,
    currentIntentId: "agendar_visita",
    step: "esperando_confirmacion_horario",
    pausedByBroker: false,
    context: context as unknown as Record<string, unknown>,
    updatedAt: new Date().toISOString(),
  });

  return { responseText, toolsCalled, escalate: false };
}

/**
 * Segundo turno: el cliente ya vio los horarios propuestos y esta es su
 * respuesta. Si no elige ninguno de los propuestos (incluye pedir un
 * horario fuera de rango habitual, que nunca llegó a proponerse), se
 * escala en vez de adivinar qué quiso decir.
 */
export async function continueAgendarVisita(
  message: IncomingWhatsAppMessage,
  state: ConversationState,
  intent: Intent,
  deps: AgendarVisitaDeps
): Promise<AgendarVisitaStepResult> {
  const context = state.context as unknown as AgendarVisitaContext;
  const { chosenIndex } = await deps.slotConfirmationClassifier.matchSlot(
    message.text,
    context.proposedLabels
  );

  if (chosenIndex === null) {
    await deps.conversationStateStore.save(idleState(message.from, message.from));
    return {
      responseText: intent.response.template ?? DEFAULT_ESCALATION_TEXT,
      toolsCalled: [],
      escalate: true,
      escalationReason: intent.escalation_reason,
    };
  }

  const slot = context.proposedSlots[chosenIndex];
  const property = await deps.tokko.getProperty(context.propertyId);
  const toolsCalled: string[] = ["tokko.get_property"];

  toolsCalled.push("gcal.create_event");
  const event = await deps.gcal.createEvent({
    summary: `Visita - ${property?.direccionCorta ?? context.propertyId}`,
    startDateTime: slot.startDateTime,
    endDateTime: slot.endDateTime,
  });

  toolsCalled.push("tokko.log_activity");
  await deps.tokko.logActivity({
    leadId: message.from,
    propertyId: context.propertyId,
    tipo: "visita_agendada",
  });

  await deps.appointmentStore.save({
    id: randomUUID(),
    leadId: message.from,
    propertyId: context.propertyId,
    gcalEventId: event.id,
    fechaHora: slot.startDateTime,
    estado: "confirmada",
    vecesReprogramada: 0,
    remindersSent: [],
  });

  await deps.conversationStateStore.save(idleState(message.from, message.from));

  const direccionCorta = property?.direccionCorta ?? "la propiedad";
  return {
    responseText: `¡Listo! Quedó agendada la visita a ${direccionCorta} para el ${formatSlotForHuman(slot.startDateTime)}.`,
    toolsCalled,
    escalate: false,
  };
}
