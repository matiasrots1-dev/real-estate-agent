import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Appointment, IntentCatalog, Property } from "shared-types";
import { loadCatalog } from "../agent/intentCatalog.js";
import { InMemoryAppointmentStore } from "../agent/appointmentStore.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WeatherQueries } from "../mcp/weatherMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import { createReminderJob, type ReminderJobDeps } from "./reminders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));

const NOW = new Date("2026-08-01T12:00:00.000Z");

const property: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
  lat: -34.5875,
  lng: -58.409,
};

function sampleAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    leadId: "5491100000001",
    propertyId: "prop-1",
    gcalEventId: "evt-1",
    fechaHora: "2026-08-02T12:00:00.000Z", // exactamente 24h después de NOW
    estado: "confirmada",
    vecesReprogramada: 0,
    remindersSent: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReminderJobDeps> = {}): ReminderJobDeps & { sendTemplate: ReturnType<typeof vi.fn> } {
  const sendTemplate = vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } }));
  const sender: WhatsAppSender = { sendText: vi.fn(), sendImage: vi.fn(), sendTemplate };
  const tokko: TokkoQueries = {
    searchProperties: vi.fn(),
    getProperty: vi.fn(async () => property),
    logActivity: vi.fn(),
  };
  const weather: WeatherQueries = {
    getForecast: vi.fn(async () => ({
      timestamp: "2026-08-02T12:00:00.000Z",
      descripcion: "cielo claro",
      temperaturaC: 22,
      probabilidadLluvia: 0.1,
    })),
  };

  return {
    catalog,
    appointmentStore: new InMemoryAppointmentStore(),
    tokko,
    weather,
    sender,
    defaultLat: -34.6037,
    defaultLng: -58.3816,
    now: () => NOW,
    sendTemplate,
    ...overrides,
  };
}

describe("createReminderJob", () => {
  it("no manda nada si la visita está a más de 24hs", async () => {
    const deps = makeDeps();
    await deps.appointmentStore.save(
      sampleAppointment({ fechaHora: "2026-08-05T12:00:00.000Z" }) // 4 días después de NOW
    );

    await createReminderJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("manda el recordatorio -24h cuando se cumple el offset, y lo marca en remindersSent", async () => {
    const deps = makeDeps();
    const store = deps.appointmentStore;
    await store.save(sampleAppointment()); // fechaHora = NOW + 24h exacto

    await createReminderJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledTimes(1);
    expect(deps.sendTemplate).toHaveBeenCalledWith(
      "5491100000001",
      "recordatorio_visita_v1",
      "es_AR",
      ["Depto Palermo", expect.any(String), "cielo claro, 22°C"]
    );

    const updated = await store.findById("appt-1");
    expect(updated?.remindersSent).toEqual(["-24h"]);
  });

  it("no duplica un recordatorio ya mandado si el job corre de nuevo", async () => {
    const deps = makeDeps();
    await deps.appointmentStore.save(sampleAppointment({ remindersSent: ["-24h"] }));

    await createReminderJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("manda -2h aunque -24h ya se haya mandado antes", async () => {
    const deps = makeDeps();
    await deps.appointmentStore.save(
      sampleAppointment({ fechaHora: "2026-08-01T14:00:00.000Z", remindersSent: ["-24h"] }) // NOW + 2h exacto
    );

    await createReminderJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledTimes(1);
    const updated = await deps.appointmentStore.findById("appt-1");
    expect(updated?.remindersSent).toEqual(["-24h", "-2h"]);
  });

  it("no manda nada para una visita que ya pasó", async () => {
    const deps = makeDeps();
    await deps.appointmentStore.save(sampleAppointment({ fechaHora: "2026-08-01T00:00:00.000Z" }));

    await createReminderJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("si el envío falla para una cita, sigue procesando las demás y no marca remindersSent", async () => {
    const deps = makeDeps();
    deps.sendTemplate.mockRejectedValueOnce(new Error("WhatsApp caído"));
    await deps.appointmentStore.save(sampleAppointment({ id: "appt-falla" }));
    await deps.appointmentStore.save(sampleAppointment({ id: "appt-ok", leadId: "5491100000002" }));

    await createReminderJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledTimes(2);
    expect((await deps.appointmentStore.findById("appt-falla"))?.remindersSent).toEqual([]);
    expect((await deps.appointmentStore.findById("appt-ok"))?.remindersSent).toEqual(["-24h"]);
  });
});
