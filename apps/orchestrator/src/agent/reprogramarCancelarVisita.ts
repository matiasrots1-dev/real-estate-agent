import type { ConversationState, Intent } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { AppointmentStore } from "./appointmentStore.js";
import type { ConversationStateStore } from "./conversationStateStore.js";
import { idleState } from "./conversationStateStore.js";
import type { SlotConfirmationClassifier } from "./slotConfirmation.js";
import type { ReprogramActionClassifier } from "./reprogramActionClassifier.js";
import { formatSlotForHuman, proposeAvailableSlots, type ProposedSlot } from "./slotProposal.js";

const NO_APPOINTMENT_FALLBACK =
  "No te veo ninguna visita agendada activa — ¿me confirmás la dirección o coordinamos una nueva?";
const DEFAULT_ESCALATION_TEXT = "Dejame confirmarlo con el asesor y te respondo enseguida.";
const SECOND_REPROGRAM_ESCALATION_REASON =
  "Si es la 2da reprogramación de la misma visita, escalar (posible señal de desinterés o cliente problemático) en vez de reprogramar automáticamente de nuevo.";

export interface ReprogramarCancelarVisitaDeps {
  tokko: TokkoQueries;
  gcal: GcalQueries;
  conversationStateStore: ConversationStateStore;
  appointmentStore: AppointmentStore;
  slotConfirmationClassifier: SlotConfirmationClassifier;
  reprogramActionClassifier: ReprogramActionClassifier;
}

export interface ReprogramarCancelarVisitaStepResult {
  responseText: string;
  toolsCalled: string[];
  escalate: boolean;
  escalationReason?: string;
}

interface ReprogramContext {
  appointmentId: string;
  propertyId: string;
  gcalEventId: string;
  proposedSlots: ProposedSlot[];
  proposedLabels: string[];
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

/**
 * Primer turno de reprogramar_cancelar_visita (docs/intent_catalog.yaml):
 * encuentra la visita activa del lead, decide si el cliente quiere
 * cancelarla o reprogramarla, y actúa según corresponda. Cancelar es
 * inmediato (el mensaje ya es la confirmación); reprogramar propone nuevos
 * horarios y espera confirmación, igual que agendar_visita.
 */
export async function startReprogramarCancelarVisita(
  message: IncomingWhatsAppMessage,
  intent: Intent,
  deps: ReprogramarCancelarVisitaDeps
): Promise<ReprogramarCancelarVisitaStepResult> {
  const appointment = await deps.appointmentStore.findActiveByLead(message.from);
  if (!appointment) {
    return { responseText: NO_APPOINTMENT_FALLBACK, toolsCalled: [], escalate: false };
  }

  const { accion } = await deps.reprogramActionClassifier.extractAction(message.text);
  const property = await deps.tokko.getProperty(appointment.propertyId);
  const direccionCorta = property?.direccionCorta ?? "la propiedad";
  const template = intent.response.template ?? "Listo, {accion} tu visita de {direccion_corta}. {detalle_nuevo_horario}";

  if (accion === "cancelar") {
    await deps.gcal.deleteEvent(appointment.gcalEventId as string);
    await deps.tokko.logActivity({
      leadId: message.from,
      propertyId: appointment.propertyId,
      tipo: "visita_cancelada",
    });
    await deps.appointmentStore.save({ ...appointment, estado: "cancelada" });

    return {
      responseText: renderTemplate(template, {
        accion: "cancelamos",
        direccion_corta: direccionCorta,
        detalle_nuevo_horario: "",
      }).trim(),
      toolsCalled: ["tokko.get_property", "gcal.delete_event", "tokko.log_activity"],
      escalate: false,
    };
  }

  // accion === "reprogramar"
  if (appointment.vecesReprogramada >= 1) {
    return {
      responseText: intent.response.template
        ? renderTemplate(template, { accion: "no pudimos reprogramar", direccion_corta: direccionCorta, detalle_nuevo_horario: "" }).trim()
        : DEFAULT_ESCALATION_TEXT,
      toolsCalled: ["tokko.get_property"],
      escalate: true,
      escalationReason: SECOND_REPROGRAM_ESCALATION_REASON,
    };
  }

  const { slots, toolsCalled: slotTools } = await proposeAvailableSlots(deps.gcal, new Date().toISOString());
  const toolsCalled = ["tokko.get_property", ...slotTools];

  if (slots.length === 0) {
    return {
      responseText: intent.response.template ?? DEFAULT_ESCALATION_TEXT,
      toolsCalled,
      escalate: true,
      escalationReason: intent.escalation_reason,
    };
  }

  const proposedLabels = slots.map((slot) => formatSlotForHuman(slot.startDateTime));
  const context: ReprogramContext = {
    appointmentId: appointment.id,
    propertyId: appointment.propertyId,
    gcalEventId: appointment.gcalEventId as string,
    proposedSlots: slots,
    proposedLabels,
  };

  await deps.conversationStateStore.save({
    conversationId: message.from,
    channel: "cliente",
    phoneNumber: message.from,
    currentIntentId: "reprogramar_cancelar_visita",
    step: "esperando_confirmacion_reprogramacion",
    pausedByBroker: false,
    context: context as unknown as Record<string, unknown>,
    updatedAt: new Date().toISOString(),
  });

  const optionsText = proposedLabels.map((label, index) => `${index + 1}. ${label}`).join("\n");
  return {
    responseText: `¿Cuál de estos horarios te queda mejor para reprogramar la visita a ${direccionCorta}?\n${optionsText}`,
    toolsCalled,
    escalate: false,
  };
}

/** Segundo turno: el cliente eligió (o no) uno de los horarios propuestos para reprogramar. */
export async function continueReprogramarCancelarVisita(
  message: IncomingWhatsAppMessage,
  state: ConversationState,
  intent: Intent,
  deps: ReprogramarCancelarVisitaDeps
): Promise<ReprogramarCancelarVisitaStepResult> {
  const context = state.context as unknown as ReprogramContext;
  const { chosenIndex } = await deps.slotConfirmationClassifier.matchSlot(message.text, context.proposedLabels);

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
  const appointment = await deps.appointmentStore.findById(context.appointmentId);
  const property = await deps.tokko.getProperty(context.propertyId);
  const direccionCorta = property?.direccionCorta ?? "la propiedad";
  const toolsCalled = ["tokko.get_property"];

  toolsCalled.push("gcal.patch_event");
  await deps.gcal.patchEvent(context.gcalEventId, {
    startDateTime: slot.startDateTime,
    endDateTime: slot.endDateTime,
  });

  toolsCalled.push("tokko.log_activity");
  await deps.tokko.logActivity({
    leadId: message.from,
    propertyId: context.propertyId,
    tipo: "visita_reprogramada",
  });

  if (appointment) {
    await deps.appointmentStore.save({
      ...appointment,
      fechaHora: slot.startDateTime,
      vecesReprogramada: appointment.vecesReprogramada + 1,
    });
  }

  await deps.conversationStateStore.save(idleState(message.from, message.from));

  const template = intent.response.template ?? "Listo, {accion} tu visita de {direccion_corta}. {detalle_nuevo_horario}";
  return {
    responseText: renderTemplate(template, {
      accion: "reprogramamos",
      direccion_corta: direccionCorta,
      detalle_nuevo_horario: `Nuevo horario: ${formatSlotForHuman(slot.startDateTime)}.`,
    }),
    toolsCalled,
    escalate: false,
  };
}
