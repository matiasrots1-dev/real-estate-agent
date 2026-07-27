import type { Intent } from "shared-types";
import type { ResponseComposer } from "./composer.js";
import type { AppointmentStore } from "./appointmentStore.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";

export interface BrokerResumenAgendaResult {
  responseText: string;
  toolsCalled: string[];
}

export interface BrokerResumenAgendaDeps {
  gcal: GcalQueries;
  tokko: TokkoQueries;
  appointmentStore: AppointmentStore;
  composer: ResponseComposer;
  language: string;
  /** Inyectable para tests — default `() => new Date()`. */
  now?: () => Date;
}

// El catálogo no especifica una ventana exacta ("resumen de mañana" vs "de
// la semana") y no tenemos un extractor de fechas — 7 días es una
// simplificación deliberada del POC, no una regla de negocio real. El
// composer decide cómo encuadrarlo en el texto.
const AGENDA_WINDOW_DAYS = 7;

/**
 * docs/intent_catalog.yaml: broker_resumen_agenda (canal broker). Cruza
 * `gcal.list_events` con `AppointmentStore` para encontrar a qué lead
 * corresponde cada evento, y `tokko.get_lead` para su nombre — nunca
 * inventa un lead si no hay cita nuestra asociada al evento.
 */
export async function runBrokerResumenAgenda(
  intent: Intent,
  deps: BrokerResumenAgendaDeps
): Promise<BrokerResumenAgendaResult> {
  const now = (deps.now ?? (() => new Date()))();
  const windowEnd = new Date(now.getTime() + AGENDA_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const toolsCalled = ["gcal.list_events"];
  const events = await deps.gcal.listEvents(now.toISOString(), windowEnd.toISOString());

  let usedGetLead = false;
  const visitas = [];
  for (const event of events) {
    const appointment = await deps.appointmentStore.findByGcalEventId(event.id);
    let leadNombre: string | null = null;
    if (appointment) {
      const lead = await deps.tokko.getLead(appointment.leadId);
      usedGetLead = true;
      leadNombre = lead?.nombre ?? null;
    }
    visitas.push({ fecha: event.start, resumen: event.summary, lead: leadNombre });
  }
  if (usedGetLead) toolsCalled.push("tokko.get_lead");

  const responseText = await deps.composer.compose({
    intentDescription: intent.description,
    groundingData: { visitas },
    language: deps.language,
  });

  return { responseText, toolsCalled };
}
