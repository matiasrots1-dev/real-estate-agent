import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Appointment, IntentCatalog, Lead } from "shared-types";
import { findIntent, loadCatalog } from "./intentCatalog.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import type { GcalQueries, CalendarEvent } from "../mcp/gcalMcpClient.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { ResponseComposer } from "./composer.js";
import { runBrokerResumenAgenda, type BrokerResumenAgendaDeps } from "./brokerResumenAgenda.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));
const intent = findIntent(catalog, "broker_resumen_agenda")!;

const NOW = new Date("2026-08-01T12:00:00.000Z");

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    summary: "Visita - Depto Palermo",
    start: "2026-08-02T15:00:00.000Z",
    end: "2026-08-02T15:30:00.000Z",
    status: "confirmed",
    ...overrides,
  };
}

function sampleAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    leadId: "lead-1",
    propertyId: "prop-1",
    gcalEventId: "evt-1",
    fechaHora: "2026-08-02T15:00:00.000Z",
    estado: "confirmada",
    vecesReprogramada: 0,
    remindersSent: [],
    ...overrides,
  };
}

function sampleLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    tokkoId: "tokko-lead-1",
    nombre: "Juan Pérez",
    telefonoWhatsapp: "5491100000001",
    temperatura: "tibio",
    propiedadesDeInteres: ["prop-1"],
    diasSinRespuesta: 2,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BrokerResumenAgendaDeps> = {}): BrokerResumenAgendaDeps & {
  listEvents: ReturnType<typeof vi.fn>;
  getLead: ReturnType<typeof vi.fn>;
  compose: ReturnType<typeof vi.fn>;
} {
  const listEvents = vi.fn(async () => [event()]);
  const gcal: GcalQueries = {
    freebusy: vi.fn(),
    createEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
    getEvent: vi.fn(),
    listEvents,
  };
  const getLead = vi.fn(async () => sampleLead());
  const tokko: TokkoQueries = {
    searchProperties: vi.fn(),
    getProperty: vi.fn(),
    searchLeads: vi.fn(),
    getLead,
    logActivity: vi.fn(),
  };
  const compose = vi.fn(async () => "Tenés 1 visita esta semana: ...");
  const composer: ResponseComposer = { compose };

  return {
    gcal,
    tokko,
    appointmentStore: new InMemoryAppointmentStore(),
    composer,
    language: "es-AR",
    now: () => NOW,
    listEvents,
    getLead,
    compose,
    ...overrides,
  };
}

describe("runBrokerResumenAgenda", () => {
  it("sin eventos: compone con visitas: [] y no llama a tokko.get_lead", async () => {
    const deps = makeDeps({ listEvents: vi.fn(async () => []) });
    deps.gcal.listEvents = deps.listEvents;

    const result = await runBrokerResumenAgenda(intent, deps);

    expect(deps.compose).toHaveBeenCalledWith({
      intentDescription: intent.description,
      groundingData: { visitas: [] },
      language: "es-AR",
    });
    expect(result.toolsCalled).toEqual(["gcal.list_events"]);
  });

  it("cruza cada evento con la cita/lead correspondiente", async () => {
    const deps = makeDeps();
    await deps.appointmentStore.save(sampleAppointment());

    const result = await runBrokerResumenAgenda(intent, deps);

    expect(deps.listEvents).toHaveBeenCalledWith(NOW.toISOString(), expect.any(String));
    expect(deps.getLead).toHaveBeenCalledWith("lead-1");
    expect(deps.compose).toHaveBeenCalledWith({
      intentDescription: intent.description,
      groundingData: {
        visitas: [{ fecha: "2026-08-02T15:00:00.000Z", resumen: "Visita - Depto Palermo", lead: "Juan Pérez" }],
      },
      language: "es-AR",
    });
    expect(result.toolsCalled).toEqual(["gcal.list_events", "tokko.get_lead"]);
  });

  it("si un evento no tiene cita asociada, no inventa un lead (queda null) y no llama a get_lead", async () => {
    const deps = makeDeps();
    // sin appointment guardado -> findByGcalEventId devuelve null

    const result = await runBrokerResumenAgenda(intent, deps);

    expect(deps.getLead).not.toHaveBeenCalled();
    expect(deps.compose).toHaveBeenCalledWith(
      expect.objectContaining({ groundingData: { visitas: [{ fecha: expect.any(String), resumen: expect.any(String), lead: null }] } })
    );
    expect(result.toolsCalled).toEqual(["gcal.list_events"]);
  });
});
