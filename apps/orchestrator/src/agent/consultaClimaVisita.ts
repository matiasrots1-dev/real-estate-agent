import type { Intent } from "shared-types";
import type { ResponseComposer } from "./composer.js";
import type { AppointmentStore } from "./appointmentStore.js";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { WeatherQueries } from "../mcp/weatherMcpClient.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";

export interface ConsultaClimaVisitaResult {
  responseText: string;
  toolsCalled: string[];
}

const NO_APPOINTMENT_FALLBACK =
  "No te veo una visita agendada todavía — ¿me confirmás la fecha o coordinamos una?";

export interface ConsultaClimaVisitaDeps {
  appointmentStore: AppointmentStore;
  gcal: GcalQueries;
  tokko: TokkoQueries;
  weather: WeatherQueries;
  composer: ResponseComposer;
  language: string;
  /** Fallback cuando la propiedad no tiene lat/lng cargados (ver config.ts). */
  defaultLat: number;
  defaultLng: number;
}

/**
 * docs/intent_catalog.yaml: consulta_clima_visita. Encuentra la visita
 * activa del lead (AppointmentStore — simplificación de una sola visita
 * activa por lead, ver appointmentStore.ts), confirma fecha real contra
 * gcal.get_event, y pide el pronóstico para la ubicación de la propiedad
 * (o el default de config si Tokko no tiene lat/lng cargados).
 */
export async function runConsultaClimaVisita(
  leadId: string,
  intent: Intent,
  deps: ConsultaClimaVisitaDeps
): Promise<ConsultaClimaVisitaResult> {
  const toolsCalled: string[] = [];

  const appointment = await deps.appointmentStore.findActiveByLead(leadId);
  if (!appointment?.gcalEventId) {
    return { responseText: NO_APPOINTMENT_FALLBACK, toolsCalled };
  }

  toolsCalled.push("gcal.get_event");
  const event = await deps.gcal.getEvent(appointment.gcalEventId);

  toolsCalled.push("tokko.get_property");
  const property = await deps.tokko.getProperty(appointment.propertyId);
  const lat = property?.lat ?? deps.defaultLat;
  const lng = property?.lng ?? deps.defaultLng;

  toolsCalled.push("weather.get_forecast");
  const forecast = await deps.weather.getForecast(lat, lng, event.start);

  const wantedFields = intent.response.grounding_fields ?? ["pronostico", "temperatura"];
  const available: Record<string, unknown> = {
    pronostico: forecast.descripcion,
    temperatura: forecast.temperaturaC,
  };
  const groundingData = Object.fromEntries(
    wantedFields.map((field) => [field, available[field] ?? null])
  );

  const responseText = await deps.composer.compose({
    intentDescription: intent.description,
    groundingData,
    language: deps.language,
  });

  return { responseText, toolsCalled };
}
