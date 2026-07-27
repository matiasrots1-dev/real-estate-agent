import { randomUUID } from "node:crypto";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { AppointmentStore } from "./appointmentStore.js";
import type { PlannedAction } from "./brokerAccionDirectaPlan.js";

export interface BrokerAccionDirectaExecutorDeps {
  gcal: GcalQueries;
  appointmentStore: AppointmentStore;
  /** Sin sender configurado, las acciones de whatsapp fallan (best-effort, no rompe las demás). */
  sender?: WhatsAppSender;
}

export interface ExecutedAction {
  action: PlannedAction;
  ok: boolean;
  error?: string;
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
      await executeOne(action, deps);
      results.push({ action, ok: true });
    } catch (error) {
      results.push({ action, ok: false, error: (error as Error).message });
    }
  }
  return results;
}

async function executeOne(action: PlannedAction, deps: BrokerAccionDirectaExecutorDeps): Promise<void> {
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
      return;
    }
    case "gcal_patch_event": {
      await deps.gcal.patchEvent(action.gcalEventId, {
        startDateTime: action.startDateTime,
        endDateTime: action.endDateTime,
        summary: action.summary,
      });
      return;
    }
    case "whatsapp_send_message": {
      if (!deps.sender) throw new Error("No hay WhatsAppSender configurado.");
      await deps.sender.sendText(action.phone, action.message);
      return;
    }
    case "whatsapp_send_template": {
      if (!deps.sender) throw new Error("No hay WhatsAppSender configurado.");
      await deps.sender.sendTemplate(action.phone, action.templateName, action.languageCode, action.bodyParams);
      return;
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
    const label = describeAction(r.action);
    return r.ok ? `✓ ${label}` : `✗ ${label} (${r.error})`;
  });
  return lines.join("\n");
}

function describeAction(action: PlannedAction): string {
  switch (action.type) {
    case "gcal_create_event":
      return `Visita agendada para ${action.leadId} (${action.summary})`;
    case "gcal_patch_event":
      return `Visita modificada para ${action.leadId}`;
    case "whatsapp_send_message":
      return `Mensaje enviado a ${action.phone}`;
    case "whatsapp_send_template":
      return `Plantilla "${action.templateName}" enviada a ${action.phone}`;
  }
}
