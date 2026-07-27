import { describe, expect, it, vi } from "vitest";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import { InMemoryAppointmentStore } from "./appointmentStore.js";
import type { PlannedAction } from "./brokerAccionDirectaPlan.js";
import { executeActionPlan, summarizeExecution, toolsCalledForPlan } from "./brokerAccionDirectaExecutor.js";

function stubGcal(): GcalQueries {
  return {
    freebusy: vi.fn(),
    createEvent: vi.fn(async () => ({ id: "evt-nuevo", summary: "Visita", start: "x", end: "y", status: "confirmed" })),
    patchEvent: vi.fn(async () => ({ id: "evt-1", summary: "Visita", start: "x", end: "y", status: "confirmed" })),
    deleteEvent: vi.fn(),
    getEvent: vi.fn(),
    listEvents: vi.fn(),
  };
}

function stubSender(): WhatsAppSender {
  return {
    sendText: vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } })),
    sendImage: vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } })),
    sendTemplate: vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } })),
  };
}

describe("executeActionPlan", () => {
  it("gcal_create_event: crea el evento y guarda la Appointment (para que broker_resumen_agenda la vea)", async () => {
    const gcal = stubGcal();
    const appointmentStore = new InMemoryAppointmentStore();
    const action: PlannedAction = {
      type: "gcal_create_event",
      leadId: "lead-1",
      propertyId: "prop-1",
      startDateTime: "2026-08-02T15:00:00.000Z",
      endDateTime: "2026-08-02T15:30:00.000Z",
      summary: "Visita - Depto Palermo",
    };

    const results = await executeActionPlan([action], { gcal, appointmentStore });

    expect(gcal.createEvent).toHaveBeenCalledWith({
      summary: "Visita - Depto Palermo",
      startDateTime: "2026-08-02T15:00:00.000Z",
      endDateTime: "2026-08-02T15:30:00.000Z",
    });
    expect(results).toEqual([{ action, ok: true }]);
    const saved = await appointmentStore.findByGcalEventId("evt-nuevo");
    expect(saved).toMatchObject({ leadId: "lead-1", propertyId: "prop-1", estado: "confirmada" });
  });

  it("gcal_patch_event: llama a patchEvent con el id y los campos provistos", async () => {
    const gcal = stubGcal();
    const action: PlannedAction = {
      type: "gcal_patch_event",
      leadId: "lead-1",
      gcalEventId: "evt-1",
      startDateTime: "2026-08-03T15:00:00.000Z",
    };

    await executeActionPlan([action], { gcal, appointmentStore: new InMemoryAppointmentStore() });

    expect(gcal.patchEvent).toHaveBeenCalledWith("evt-1", {
      startDateTime: "2026-08-03T15:00:00.000Z",
      endDateTime: undefined,
      summary: undefined,
    });
  });

  it("whatsapp_send_message: manda el texto al teléfono del plan", async () => {
    const sender = stubSender();
    const action: PlannedAction = { type: "whatsapp_send_message", leadId: "lead-1", phone: "5491100000001", message: "Hola!" };

    await executeActionPlan([action], { gcal: stubGcal(), appointmentStore: new InMemoryAppointmentStore(), sender });

    expect(sender.sendText).toHaveBeenCalledWith("5491100000001", "Hola!");
  });

  it("whatsapp_send_template: manda la plantilla con sus params", async () => {
    const sender = stubSender();
    const action: PlannedAction = {
      type: "whatsapp_send_template",
      leadId: "lead-1",
      phone: "5491100000001",
      templateName: "baja_precio",
      languageCode: "es_AR",
      bodyParams: ["Depto Palermo"],
    };

    await executeActionPlan([action], { gcal: stubGcal(), appointmentStore: new InMemoryAppointmentStore(), sender });

    expect(sender.sendTemplate).toHaveBeenCalledWith("5491100000001", "baja_precio", "es_AR", ["Depto Palermo"]);
  });

  it("acción de whatsapp sin sender configurado: falla esa acción puntual (no revienta el resto del plan)", async () => {
    const gcal = stubGcal();
    const actions: PlannedAction[] = [
      { type: "whatsapp_send_message", leadId: "lead-1", phone: "5491100000001", message: "Hola!" },
      { type: "gcal_patch_event", leadId: "lead-2", gcalEventId: "evt-1", summary: "Reprogramada" },
    ];

    const results = await executeActionPlan(actions, { gcal, appointmentStore: new InMemoryAppointmentStore() });

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/WhatsAppSender/);
    expect(results[1].ok).toBe(true);
    expect(gcal.patchEvent).toHaveBeenCalledTimes(1);
  });

  it("una acción que falla no bloquea las siguientes (best-effort, mismo criterio que jobs/recontact.ts)", async () => {
    const gcal = stubGcal();
    gcal.createEvent = vi.fn(async () => {
      throw new Error("Calendar caído");
    });
    const actions: PlannedAction[] = [
      {
        type: "gcal_create_event",
        leadId: "lead-1",
        propertyId: "prop-1",
        startDateTime: "x",
        endDateTime: "y",
        summary: "Visita",
      },
      { type: "gcal_patch_event", leadId: "lead-2", gcalEventId: "evt-1", summary: "Reprogramada" },
    ];

    const results = await executeActionPlan(actions, { gcal, appointmentStore: new InMemoryAppointmentStore() });

    expect(results[0]).toMatchObject({ ok: false, error: "Calendar caído" });
    expect(results[1]).toMatchObject({ ok: true });
  });
});

describe("toolsCalledForPlan", () => {
  it("mapea cada tipo de acción al nombre de tool del catálogo", () => {
    const actions: PlannedAction[] = [
      { type: "gcal_create_event", leadId: "l1", propertyId: "p1", startDateTime: "x", endDateTime: "y", summary: "s" },
      { type: "whatsapp_send_message", leadId: "l2", phone: "5491100000002", message: "hola" },
    ];
    expect(toolsCalledForPlan(actions)).toEqual(["gcal.create_event", "whatsapp.send_message"]);
  });
});

describe("summarizeExecution", () => {
  it("sin acciones: lo dice explícitamente, no inventa un resumen", () => {
    expect(summarizeExecution([])).toBe("No había ninguna acción para ejecutar.");
  });

  it("mezcla de éxitos y fallos: cada línea refleja lo que pasó realmente con esa acción", () => {
    const action: PlannedAction = { type: "whatsapp_send_message", leadId: "lead-1", phone: "5491100000001", message: "Hola!" };
    const summary = summarizeExecution([{ action, ok: false, error: "boom" }]);
    expect(summary).toContain("✗");
    expect(summary).toContain("boom");
  });
});
