import { randomUUID } from "node:crypto";
import type { Appointment, IntentCatalog } from "shared-types";
import { findIntent } from "../agent/intentCatalog.js";
import type { AppointmentStore } from "../agent/appointmentStore.js";
import type { AuditLogStore } from "../agent/auditLog.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { ScheduledJob } from "./scheduler.js";
import { parseOffsetToMs } from "./scheduleOffset.js";

export interface SeguimientoPostVisitaJobDeps {
  catalog: IntentCatalog;
  appointmentStore: AppointmentStore;
  auditLog: AuditLogStore;
  tokko: TokkoQueries;
  sender: WhatsAppSender;
  /** Inyectable para tests — default `() => new Date()`. */
  now?: () => Date;
}

function toWhatsAppLanguageCode(catalogLanguage: string): string {
  return catalogLanguage.replace("-", "_");
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

async function sendSeguimientoFor(
  appointment: Appointment,
  templateName: string,
  languageCode: string,
  template: string,
  deps: SeguimientoPostVisitaJobDeps
): Promise<void> {
  const property = await deps.tokko.getProperty(appointment.propertyId);
  const direccionCorta = property?.direccionCorta ?? "la propiedad";

  await deps.sender.sendTemplate(appointment.leadId, templateName, languageCode, [direccionCorta]);

  await deps.tokko.logActivity({
    leadId: appointment.leadId,
    propertyId: appointment.propertyId,
    tipo: "seguimiento_post_visita",
  });

  // "Marcar Appointment.estado = realizada antes de disparar el
  // seguimiento" (docs/TASKS.md Bloque 7) — se hace acá, en el mismo paso:
  // no hace falta un pase separado, +3h ya es tiempo de sobra después de
  // que la visita terminó (30 min, ver slotProposal.ts).
  await deps.appointmentStore.save({ ...appointment, estado: "realizada" });

  const responseText = renderTemplate(template, { direccion_corta: direccionCorta });
  await deps.auditLog.append({
    id: randomUUID(),
    conversationId: appointment.leadId,
    timestamp: new Date().toISOString(),
    incomingMessage: "[seguimiento post-visita automático — sin mensaje entrante]",
    matchedIntentId: "seguimiento_post_visita",
    confidence: null,
    toolsCalled: ["tokko.get_property", "tokko.log_activity", "whatsapp.send_template"],
    escalatedToBroker: false,
    responseSent: responseText,
  });
}

/**
 * docs/intent_catalog.yaml: seguimiento_post_visita. Dispara +3h después de
 * la visita (schedule_rules del catálogo, nunca hardcodeado) pidiendo
 * feedback, y de paso marca la cita como `realizada` — de ahí en más
 * `AppointmentStore.listActive()` deja de traerla (no hace falta un
 * segundo pase para "cerrar" la visita).
 */
export function createSeguimientoPostVisitaJob(deps: SeguimientoPostVisitaJobDeps): ScheduledJob {
  return {
    name: "seguimiento_post_visita",
    async run(): Promise<void> {
      const intent = findIntent(deps.catalog, "seguimiento_post_visita");
      const offsetRule = intent?.schedule_rules?.find((rule) => rule.offset);
      if (!intent || !offsetRule?.offset || !intent.response.whatsapp_template_name || !intent.response.template) {
        console.error(
          'jobs/seguimientoPostVisita: el intent "seguimiento_post_visita" no tiene schedule_rules, template o whatsapp_template_name en el catálogo.'
        );
        return;
      }

      const templateName = intent.response.whatsapp_template_name;
      const template = intent.response.template;
      const languageCode = toWhatsAppLanguageCode(deps.catalog.meta.language);
      const offsetMs = parseOffsetToMs(offsetRule.offset);
      const now = (deps.now ?? (() => new Date()))();

      const appointments = await deps.appointmentStore.listActive();
      for (const appointment of appointments) {
        const visitMs = new Date(appointment.fechaHora).getTime();
        const triggerAtMs = visitMs + offsetMs;
        if (now.getTime() < triggerAtMs) continue; // todavía no pasó el offset desde la visita

        try {
          await sendSeguimientoFor(appointment, templateName, languageCode, template, deps);
        } catch (error) {
          console.error(
            `jobs/seguimientoPostVisita: no se pudo mandar el seguimiento de la cita ${appointment.id}:`,
            error
          );
        }
      }
    },
  };
}
