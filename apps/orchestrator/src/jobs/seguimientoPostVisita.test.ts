import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Appointment, IntentCatalog, Property } from "shared-types";
import { loadCatalog } from "../agent/intentCatalog.js";
import { InMemoryAppointmentStore } from "../agent/appointmentStore.js";
import { InMemoryAuditLogStore } from "../agent/auditLog.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import { createSeguimientoPostVisitaJob, type SeguimientoPostVisitaJobDeps } from "./seguimientoPostVisita.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));

const NOW = new Date("2026-08-01T18:00:00.000Z"); // 3hs después de la visita de ejemplo

const property: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
};

function sampleAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    leadId: "5491100000001",
    propertyId: "prop-1",
    gcalEventId: "evt-1",
    fechaHora: "2026-08-01T15:00:00.000Z", // NOW - 3h exacto
    estado: "confirmada",
    vecesReprogramada: 0,
    remindersSent: [],
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SeguimientoPostVisitaJobDeps> = {}
): SeguimientoPostVisitaJobDeps & { sendTemplate: ReturnType<typeof vi.fn>; logActivity: ReturnType<typeof vi.fn> } {
  const sendTemplate = vi.fn(async () => ({ raw: { messaging_product: "whatsapp" } }));
  const sender: WhatsAppSender = { sendText: vi.fn(), sendImage: vi.fn(), sendTemplate };
  const logActivity = vi.fn(async () => ({ logged: true as const, activityId: "act-1" }));
  const tokko: TokkoQueries = {
    searchProperties: vi.fn(),
    getProperty: vi.fn(async () => property),
    searchLeads: vi.fn(),
    getLead: vi.fn(),
    logActivity,
  };

  return {
    catalog,
    appointmentStore: new InMemoryAppointmentStore(),
    auditLog: new InMemoryAuditLogStore(),
    tokko,
    sender,
    now: () => NOW,
    sendTemplate,
    logActivity,
    ...overrides,
  };
}

describe("createSeguimientoPostVisitaJob", () => {
  it("no manda nada si todavía no pasaron las 3hs desde la visita", async () => {
    const deps = makeDeps();
    await deps.appointmentStore.save(sampleAppointment({ fechaHora: "2026-08-01T17:00:00.000Z" })); // hace 1h

    await createSeguimientoPostVisitaJob(deps).run();

    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  it("manda el seguimiento, loguea actividad, y marca la visita como realizada", async () => {
    const deps = makeDeps();
    await deps.appointmentStore.save(sampleAppointment());

    await createSeguimientoPostVisitaJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledWith(
      "5491100000001",
      "seguimiento_post_visita_v1",
      "es_AR",
      ["Depto Palermo"]
    );
    expect(deps.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "5491100000001", tipo: "seguimiento_post_visita" })
    );

    const updated = await deps.appointmentStore.findById("appt-1");
    expect(updated?.estado).toBe("realizada");

    const [entry] = await deps.auditLog.readAll();
    expect(entry).toMatchObject({
      matchedIntentId: "seguimiento_post_visita",
      escalatedToBroker: false,
      responseSent: "¿Qué te pareció la propiedad de Depto Palermo? Cualquier duda quedo atento.",
    });
  });

  it("una vez marcada realizada, deja de aparecer en corridas siguientes (no se duplica)", async () => {
    const deps = makeDeps();
    await deps.appointmentStore.save(sampleAppointment());

    await createSeguimientoPostVisitaJob(deps).run();
    await createSeguimientoPostVisitaJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("si falla un envío, sigue procesando las demás citas", async () => {
    const deps = makeDeps();
    deps.sendTemplate.mockRejectedValueOnce(new Error("WhatsApp caído"));
    await deps.appointmentStore.save(sampleAppointment({ id: "appt-falla" }));
    await deps.appointmentStore.save(sampleAppointment({ id: "appt-ok", leadId: "5491100000002" }));

    await createSeguimientoPostVisitaJob(deps).run();

    expect(deps.sendTemplate).toHaveBeenCalledTimes(2);
    expect((await deps.appointmentStore.findById("appt-falla"))?.estado).toBe("confirmada");
    expect((await deps.appointmentStore.findById("appt-ok"))?.estado).toBe("realizada");
  });
});
