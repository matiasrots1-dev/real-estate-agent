import { describe, expect, it, vi } from "vitest";
import type { Appointment, Intent, Property } from "shared-types";
import type { AppointmentStore } from "./appointmentStore.js";
import type { GcalQueries, CalendarEvent } from "../mcp/gcalMcpClient.js";
import type { WeatherQueries, ForecastSlot } from "../mcp/weatherMcpClient.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { ResponseComposer } from "./composer.js";
import { runConsultaClimaVisita } from "./consultaClimaVisita.js";

const intent: Intent = {
  id: "consulta_clima_visita",
  description: "Cliente (o vos) pregunta por el clima de una visita agendada.",
  channel: "any",
  priority: "low",
  triggers: { examples: ["¿va a llover el sábado?"] },
  tools: ["gcal.get_event", "weather.get_forecast"],
  requires_client_confirmation: false,
  requires_broker: false,
  confidence_threshold: 0.7,
  response: { style: "generative_grounded", grounding_fields: ["pronostico", "temperatura"] },
};

const appointment: Appointment = {
  id: "appt-1",
  leadId: "5491100000001",
  propertyId: "prop-1",
  gcalEventId: "evt-1",
  fechaHora: "2026-08-01T15:00:00-03:00",
  estado: "confirmada",
  vecesReprogramada: 0,
  remindersSent: [],
};

const event: CalendarEvent = {
  id: "evt-1",
  summary: "Visita depto Palermo",
  start: "2026-08-01T15:00:00-03:00",
  end: "2026-08-01T15:30:00-03:00",
  status: "confirmed",
};

const propertyConCoords: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
  lat: -34.5875,
  lng: -58.409,
};

const forecast: ForecastSlot = {
  timestamp: "2026-08-01T15:00:00.000Z",
  descripcion: "parcialmente nublado",
  temperaturaC: 18,
  probabilidadLluvia: 0.1,
};

function stubAppointmentStore(found: Appointment | null): AppointmentStore {
  return {
    save: vi.fn(async () => {}),
    findById: vi.fn(async () => found),
    findActiveByLead: vi.fn(async () => found),
  };
}

describe("runConsultaClimaVisita", () => {
  it("busca la visita activa, confirma el evento real, y pide el pronóstico con lat/lng de la propiedad", async () => {
    const gcal: GcalQueries = {
      freebusy: vi.fn(),
      createEvent: vi.fn(),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
      getEvent: vi.fn(async () => event),
      listEvents: vi.fn(),
    };
    const tokko: TokkoQueries = {
      searchProperties: vi.fn(),
      getProperty: vi.fn(async () => propertyConCoords),
    };
    const getForecast = vi.fn(async () => forecast);
    const weather: WeatherQueries = { getForecast };
    const compose = vi.fn(async () => "Va a estar parcialmente nublado, 18°.");
    const composer: ResponseComposer = { compose };

    const result = await runConsultaClimaVisita(
      "5491100000001",
      intent,
      {
        appointmentStore: stubAppointmentStore(appointment),
        gcal,
        tokko,
        weather,
        composer,
        language: "es-AR",
        defaultLat: -34.6037,
        defaultLng: -58.3816,
      }
    );

    expect(gcal.getEvent).toHaveBeenCalledWith("evt-1");
    expect(getForecast).toHaveBeenCalledWith(-34.5875, -58.409, event.start);
    expect(compose).toHaveBeenCalledWith({
      intentDescription: intent.description,
      groundingData: { pronostico: "parcialmente nublado", temperatura: 18 },
      language: "es-AR",
    });
    expect(result.responseText).toBe("Va a estar parcialmente nublado, 18°.");
    expect(result.toolsCalled).toEqual(["gcal.get_event", "tokko.get_property", "weather.get_forecast"]);
  });

  it("usa lat/lng por defecto si la propiedad no las tiene cargadas", async () => {
    const gcal: GcalQueries = {
      freebusy: vi.fn(),
      createEvent: vi.fn(),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
      getEvent: vi.fn(async () => event),
      listEvents: vi.fn(),
    };
    const tokko: TokkoQueries = {
      searchProperties: vi.fn(),
      getProperty: vi.fn(async () => ({ ...propertyConCoords, lat: undefined, lng: undefined })),
    };
    const getForecast = vi.fn(async () => forecast);
    const weather: WeatherQueries = { getForecast };
    const composer: ResponseComposer = { compose: vi.fn(async () => "respuesta") };

    await runConsultaClimaVisita("5491100000001", intent, {
      appointmentStore: stubAppointmentStore(appointment),
      gcal,
      tokko,
      weather,
      composer,
      language: "es-AR",
      defaultLat: -34.6037,
      defaultLng: -58.3816,
    });

    expect(getForecast).toHaveBeenCalledWith(-34.6037, -58.3816, event.start);
  });

  it("no inventa una visita: si no hay ninguna activa, pide confirmación", async () => {
    const gcal: GcalQueries = {
      freebusy: vi.fn(),
      createEvent: vi.fn(),
      patchEvent: vi.fn(),
      deleteEvent: vi.fn(),
      getEvent: vi.fn(),
      listEvents: vi.fn(),
    };
    const weather: WeatherQueries = { getForecast: vi.fn() };
    const composer: ResponseComposer = { compose: vi.fn(async () => "no debería llamarse") };

    const result = await runConsultaClimaVisita("5491100000002", intent, {
      appointmentStore: stubAppointmentStore(null),
      gcal,
      tokko: { searchProperties: vi.fn(), getProperty: vi.fn() },
      weather,
      composer,
      language: "es-AR",
      defaultLat: -34.6037,
      defaultLng: -58.3816,
    });

    expect(gcal.getEvent).not.toHaveBeenCalled();
    expect(composer.compose).not.toHaveBeenCalled();
    expect(result.responseText).toMatch(/visita agendada/);
  });
});
