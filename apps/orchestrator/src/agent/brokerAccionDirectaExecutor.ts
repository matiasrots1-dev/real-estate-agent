import { randomUUID } from "node:crypto";
import type { Lead } from "shared-types";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { AppointmentStore } from "./appointmentStore.js";
import type { PlannedAction } from "./brokerAccionDirectaPlan.js";

export interface BrokerAccionDirectaExecutorDeps {
  gcal: GcalQueries;
  appointmentStore: AppointmentStore;
  /**
   * El executor resuelve acá el teléfono y el nombre del lead a partir de su
   * `id` (docs/TASKS.md Bloque 16). El planificador nunca los ve: mandarlos
   * a la API de Claude no hacía falta para armar el plan.
   */
  tokko: TokkoQueries;
  /** Sin sender configurado, las acciones de whatsapp fallan (best-effort, no rompe las demás). */
  sender?: WhatsAppSender;
}

export interface ExecutedAction {
  action: PlannedAction;
  ok: boolean;
  error?: string;
  /** Teléfono resuelto en ejecución — para que el resumen al broker sea útil. */
  telefono?: string;
}

/**
 * Ejecuta cada acción del plan de broker_accion_directa contra Calendar/
 * WhatsApp de verdad. Best-effort por acción (mismo criterio que
 * jobs/reminders.ts y jobs/recontact.ts): si una falla, las demás igual se
 * intentan — el broker ve el detalle en la respuesta, no queda a mitad de
 * camino sin saber qué pasó.
 */
export async function executeActionPlan(
  actions: PlannedAction[],
  deps: BrokerAccionDirectaExecutorDeps
): Promise<ExecutedAction[]> {
  const results: ExecutedAction[] = [];
  for (const action of actions) {
    try {
      const telefono = await executeOne(action, deps);
      results.push({ action, ok: true, telefono });
    } catch (error) {
      results.push({ action, ok: false, error: (error as Error).message });
    }
  }
  return results;
}

/**
 * Resuelve el lead que el planificador solo conoce por `id`. Si Tokko no lo
 * tiene, la acción falla ruidosamente en vez de mandarle un mensaje a un
 * destinatario equivocado o inventado.
 */
async function resolverLead(leadId: string, deps: BrokerAccionDirectaExecutorDeps): Promise<Lead> {
  const lead = await deps.tokko.getLead(leadId);
  if (!lead) throw new Error(`No se encontró el lead "${leadId}" en Tokko.`);
  if (!lead.telefonoWhatsapp) throw new Error(`El lead "${leadId}" no tiene teléfono de WhatsApp cargado.`);
  return lead;
}

/**
 * El planificador escribe `{nombre}` como placeholder porque nunca recibe el
 * nombre real (docs/TASKS.md Bloque 16). Se reemplaza recién acá, con el
 * dato que vino de Tokko.
 */
function personalizar(texto: string, lead: Lead): string {
  return texto.replaceAll("{nombre}", lead.nombre);
}

/** Devuelve el teléfono resuelto, si la acción implicó mandarle algo a alguien. */
async function executeOne(
  action: PlannedAction,
  deps: BrokerAccionDirectaExecutorDeps
): Promise<string | undefined> {
  switch (action.type) {
    case "gcal_create_event": {
      const event = await deps.gcal.createEvent({
        summary: action.summary,
        startDateTime: action.startDateTime,
        endDateTime: action.endDateTime,
      });
      // Igual que agendarVisita.ts: sin esto, la visita creada acá no aparece
      // en broker_resumen_agenda ni en los jobs de recordatorio/seguimiento.
      await deps.appointmentStore.save({
        id: randomUUID(),
        leadId: action.leadId,
        propertyId: action.propertyId,
        gcalEventId: event.id,
        fechaHora: action.startDateTime,
        estado: "confirmada",
        vecesReprogramada: 0,
        remindersSent: [],
      });
      return undefined;
    }
    case "gcal_patch_event": {
      await deps.gcal.patchEvent(action.gcalEventId, {
        startDateTime: action.startDateTime,
        endDateTime: action.endDateTime,
        summary: action.summary,
      });
      return undefined;
    }
    case "whatsapp_send_message": {
      if (!deps.sender) throw new Error("No hay WhatsAppSender configurado.");
      const lead = await resolverLead(action.leadId, deps);
      await deps.sender.sendText(lead.telefonoWhatsapp, personalizar(action.message, lead));
      return lead.telefonoWhatsapp;
    }
    case "whatsapp_send_template": {
      if (!deps.sender) throw new Error("No hay WhatsAppSender configurado.");
      const lead = await resolverLead(action.leadId, deps);
      await deps.sender.sendTemplate(
        lead.telefonoWhatsapp,
        action.templateName,
        action.languageCode,
        action.bodyParams.map((p) => personalizar(p, lead))
      );
      return lead.telefonoWhatsapp;
    }
  }
}

const TOOL_NAME_BY_ACTION_TYPE: Record<PlannedAction["type"], string> = {
  gcal_create_event: "gcal.create_event",
  gcal_patch_event: "gcal.patch_event",
  whatsapp_send_message: "whatsapp.send_message",
  whatsapp_send_template: "whatsapp.send_template",
};

/** Para `audit_log.toolsCalled` — un nombre de tool del catálogo por cada acción del plan. */
export function toolsCalledForPlan(actions: PlannedAction[]): string[] {
  return actions.map((action) => TOOL_NAME_BY_ACTION_TYPE[action.type]);
}

/** Resumen para el broker de lo que efectivamente se ejecutó (o falló) — nunca inventa qué pasó. */
export function summarizeExecution(results: ExecutedAction[]): string {
  if (results.length === 0) return "No había ninguna acción para ejecutar.";
  const lines = results.map((r) => {
    const label = describeAction(r.action, r.telefono);
    return r.ok ? `✓ ${label}` : `✗ ${label} (${r.error})`;
  });
  return lines.join("\n");
}

/**
 * El resumen va al broker, que es el dueño de estos datos, así que muestra
 * el teléfono real — pero el que se resolvió en ejecución, no uno que haya
 * salido de la planificación (ahí ya no existe).
 */
function describeAction(action: PlannedAction, telefono?: string): string {
  const destinatario = telefono ?? `lead ${action.leadId}`;
  switch (action.type) {
    case "gcal_create_event":
      return `Visita agendada para ${action.leadId} (${action.summary})`;
    case "gcal_patch_event":
      return `Visita modificada para ${action.leadId}`;
    case "whatsapp_send_message":
      return `Mensaje enviado a ${destinatario}`;
    case "whatsapp_send_template":
      return `Plantilla "${action.templateName}" enviada a ${destinatario}`;
  }
}
