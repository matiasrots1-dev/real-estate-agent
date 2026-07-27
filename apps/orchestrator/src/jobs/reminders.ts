import type { Appointment, IntentCatalog } from "shared-types";
import { findIntent } from "../agent/intentCatalog.js";
import { formatSlotForHuman } from "../agent/slotProposal.js";
import type { AppointmentStore } from "../agent/appointmentStore.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WeatherQueries } from "../mcp/weatherMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { ScheduledJob } from "./scheduler.js";
import { parseOffsetToMs } from "./scheduleOffset.js";

export interface ReminderJobDeps {
  catalog: IntentCatalog;
  appointmentStore: AppointmentStore;
  tokko: TokkoQueries;
  weather: WeatherQueries;
  sender: WhatsAppSender;
  defaultLat: number;
  defaultLng: number;
  /** Inyectable para tests — default `() => new Date()`. */
  now?: () => Date;
}

/** WhatsApp usa "es_AR", el catálogo tiene "es-AR" (docs/intent_catalog.yaml meta.language). */
function toWhatsAppLanguageCode(catalogLanguage: string): string {
  return catalogLanguage.replace("-", "_");
}

async function sendReminderFor(
  appointment: Appointment,
  offset: string,
  templateName: string,
  languageCode: string,
  deps: ReminderJobDeps
): Promise<void> {
  const property = await deps.tokko.getProperty(appointment.propertyId);
  const lat = property?.lat ?? deps.defaultLat;
  const lng = property?.lng ?? deps.defaultLng;
  const forecast = await deps.weather.getForecast(lat, lng, appointment.fechaHora);

  const direccionCorta = property?.direccionCorta ?? "la propiedad";
  const fechaHoraLabel = formatSlotForHuman(appointment.fechaHora);
  const infoClima = `${forecast.descripcion}, ${forecast.temperaturaC}°C`;

  await deps.sender.sendTemplate(appointment.leadId, templateName, languageCode, [
    direccionCorta,
    fechaHoraLabel,
    infoClima,
  ]);

  appointment.remindersSent.push(offset);
  await deps.appointmentStore.save(appointment);
}

/**
 * docs/intent_catalog.yaml: recordatorio_visita. Recorre las citas activas
 * y dispara un recordatorio por cada `schedule_rule.offset` (-24h, -2h) que
 * ya se cumplió y todavía no se mandó (`Appointment.remindersSent`).
 *
 * Los offsets y el nombre de la plantilla salen del catálogo en runtime —
 * nunca hardcodeados acá (CLAUDE.md secc. 7).
 */
export function createReminderJob(deps: ReminderJobDeps): ScheduledJob {
  return {
    name: "recordatorio_visita",
    async run(): Promise<void> {
      const intent = findIntent(deps.catalog, "recordatorio_visita");
      if (!intent?.schedule_rules || !intent.response.whatsapp_template_name) {
        console.error(
          'jobs/reminders: el intent "recordatorio_visita" no tiene schedule_rules o whatsapp_template_name en el catálogo — nada para hacer.'
        );
        return;
      }
      const templateName = intent.response.whatsapp_template_name;
      const languageCode = toWhatsAppLanguageCode(deps.catalog.meta.language);
      const now = (deps.now ?? (() => new Date()))();

      const appointments = await deps.appointmentStore.listActive();
      for (const appointment of appointments) {
        const visitMs = new Date(appointment.fechaHora).getTime();
        if (visitMs <= now.getTime()) continue; // ya pasó, no tiene sentido recordar

        for (const rule of intent.schedule_rules) {
          if (!rule.offset || appointment.remindersSent.includes(rule.offset)) continue;

          const triggerAtMs = visitMs + parseOffsetToMs(rule.offset);
          if (now.getTime() < triggerAtMs) continue; // todavía no llegó el momento de este offset

          try {
            await sendReminderFor(appointment, rule.offset, templateName, languageCode, deps);
          } catch (error) {
            console.error(
              `jobs/reminders: no se pudo mandar el recordatorio ${rule.offset} de la cita ${appointment.id}:`,
              error
            );
          }
        }
      }
    },
  };
}
