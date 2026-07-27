import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Appointment } from "shared-types";
import { FileAppointmentStore, InMemoryAppointmentStore, type AppointmentStore } from "./appointmentStore.js";

function sampleAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    leadId: "5491100000001",
    propertyId: "prop-1",
    gcalEventId: "evt-1",
    fechaHora: "2026-08-01T15:00:00-03:00",
    estado: "confirmada",
    vecesReprogramada: 0,
    remindersSent: [],
    ...overrides,
  };
}

function runSharedTests(makeStore: () => AppointmentStore) {
  it("guarda y encuentra por id", async () => {
    const store = makeStore();
    const appointment = sampleAppointment();
    await store.save(appointment);
    expect(await store.findById("appt-1")).toEqual(appointment);
  });

  it("findById devuelve null si no existe", async () => {
    const store = makeStore();
    expect(await store.findById("no-existe")).toBeNull();
  });

  it("findActiveByLead ignora canceladas/realizadas", async () => {
    const store = makeStore();
    await store.save(sampleAppointment({ id: "appt-cancelada", estado: "cancelada" }));
    await store.save(sampleAppointment({ id: "appt-realizada", estado: "realizada" }));
    expect(await store.findActiveByLead("5491100000001")).toBeNull();
  });

  it("findActiveByLead encuentra la visita activa más próxima en el futuro", async () => {
    const store = makeStore();
    await store.save(
      sampleAppointment({ id: "appt-lejos", fechaHora: "2026-09-01T15:00:00-03:00" })
    );
    await store.save(
      sampleAppointment({ id: "appt-cerca", fechaHora: "2026-08-01T15:00:00-03:00" })
    );
    const active = await store.findActiveByLead("5491100000001");
    expect(active?.id).toBe("appt-cerca");
  });

  it("save sobrescribe (para reprogramaciones/cancelaciones)", async () => {
    const store = makeStore();
    await store.save(sampleAppointment());
    await store.save(sampleAppointment({ estado: "cancelada" }));
    expect((await store.findById("appt-1"))?.estado).toBe("cancelada");
  });

  it("listActive devuelve todas las citas activas de todos los leads, sin las canceladas/realizadas", async () => {
    const store = makeStore();
    await store.save(sampleAppointment({ id: "appt-1", leadId: "lead-1" }));
    await store.save(sampleAppointment({ id: "appt-2", leadId: "lead-2" }));
    await store.save(sampleAppointment({ id: "appt-cancelada", leadId: "lead-3", estado: "cancelada" }));
    await store.save(sampleAppointment({ id: "appt-realizada", leadId: "lead-4", estado: "realizada" }));

    const active = await store.listActive();
    expect(active.map((a) => a.id).sort()).toEqual(["appt-1", "appt-2"]);
  });

  it("findByGcalEventId encuentra la cita por su evento de Calendar", async () => {
    const store = makeStore();
    await store.save(sampleAppointment({ id: "appt-1", gcalEventId: "evt-abc" }));
    expect((await store.findByGcalEventId("evt-abc"))?.id).toBe("appt-1");
  });

  it("findByGcalEventId devuelve null si ningún evento matchea", async () => {
    const store = makeStore();
    expect(await store.findByGcalEventId("no-existe")).toBeNull();
  });
}

describe("InMemoryAppointmentStore", () => {
  runSharedTests(() => new InMemoryAppointmentStore());
});

describe("FileAppointmentStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "appointment-store-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runSharedTests(() => new FileAppointmentStore(path.join(dir, "appointments.json")));

  it("persiste entre instancias distintas apuntando al mismo archivo", async () => {
    const filePath = path.join(dir, "appointments.json");
    await new FileAppointmentStore(filePath).save(sampleAppointment());
    const reloaded = await new FileAppointmentStore(filePath).findById("appt-1");
    expect(reloaded?.propertyId).toBe("prop-1");
  });
});
