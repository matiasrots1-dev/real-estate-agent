import { describe, expect, it } from "vitest";
import { InMemoryAuditLogStore } from "../agent/auditLog.js";
import { InMemoryAppointmentStore } from "../agent/appointmentStore.js";
import { InMemoryConversationStateStore, idleState } from "../agent/conversationStateStore.js";
import { InMemoryRecontactStateStore } from "../agent/recontactStateStore.js";
import { InMemoryLastInteractionStore } from "../agent/lastInteractionStore.js";
import { InMemoryRetentionReportStore } from "../agent/retentionReportStore.js";
import { ejecutarRetencion, leadsVencidos, ultimaInteraccionEfectiva, type RetentionJobDeps } from "./retention.js";

const AHORA = new Date("2027-06-15T12:00:00Z");
const TELEFONO = "5491155559999";

/** Fecha a N meses antes de AHORA. */
function haceMeses(meses: number): string {
  const d = new Date(AHORA.getTime());
  d.setMonth(d.getMonth() - meses);
  return d.toISOString();
}

interface Escenario extends RetentionJobDeps {
  auditLog: InMemoryAuditLogStore;
  conversationStateStore: InMemoryConversationStateStore;
  appointmentStore: InMemoryAppointmentStore;
  recontactStateStore: InMemoryRecontactStateStore;
  lastInteractionStore: InMemoryLastInteractionStore;
  reportStore: InMemoryRetentionReportStore;
}

function escenario(overrides: Partial<RetentionJobDeps> = {}): Escenario {
  return {
    auditLog: new InMemoryAuditLogStore(),
    conversationStateStore: new InMemoryConversationStateStore(),
    appointmentStore: new InMemoryAppointmentStore(),
    recontactStateStore: new InMemoryRecontactStateStore(),
    lastInteractionStore: new InMemoryLastInteractionStore(),
    reportStore: new InMemoryRetentionReportStore(),
    mesesMensajes: 12,
    mesesGestionComercial: 24,
    borradoHabilitado: true,
    now: () => AHORA,
    ...overrides,
  } as Escenario;
}

async function sembrarLeadViejo(e: Escenario, mesesAtras: number) {
  await e.auditLog.append({
    id: "audit-viejo",
    conversationId: TELEFONO,
    timestamp: haceMeses(mesesAtras),
    incomingMessage: "hola, me interesa el depto",
    matchedIntentId: "consulta_disponibilidad",
    confidence: 0.9,
    toolsCalled: [],
    escalatedToBroker: false,
  });
  await e.conversationStateStore.save({
    ...idleState(TELEFONO, TELEFONO),
    updatedAt: haceMeses(mesesAtras),
  });
  await e.appointmentStore.save({
    id: "appt-viejo",
    leadId: TELEFONO,
    propertyId: "prop-1",
    fechaHora: haceMeses(mesesAtras),
    estado: "realizada",
    vecesReprogramada: 0,
    remindersSent: [],
  });
  await e.recontactStateStore.save({ leadId: TELEFONO, attemptsSent: ["x"], updatedAt: haceMeses(mesesAtras) });
  await e.lastInteractionStore.record(TELEFONO, new Date(haceMeses(mesesAtras)));
}

/** ¿Queda rastro del teléfono en ALGÚN store? */
async function telefonoSobrevive(e: Escenario): Promise<string[]> {
  const donde: string[] = [];
  if ((await e.auditLog.readAll()).some((a) => a.conversationId === TELEFONO)) donde.push("audit_log");
  if (await e.conversationStateStore.get(TELEFONO)) donde.push("conversations");
  if (await e.appointmentStore.findActiveByLead(TELEFONO)) donde.push("appointments");
  if ((await e.appointmentStore.ultimaVisitaPorLead())[TELEFONO]) donde.push("appointments");
  if (await e.recontactStateStore.get(TELEFONO)) donde.push("recontacts");
  if (await e.lastInteractionStore.get(TELEFONO)) donde.push("last_interaction");
  return donde;
}

describe("ejecutarRetencion — el simulacro no borra nada (modo por default)", () => {
  it("con borradoHabilitado=false reporta qué borraría pero deja todo intacto", async () => {
    const e = escenario({ borradoHabilitado: false });
    await sembrarLeadViejo(e, 30); // más viejo que los dos cortes

    const report = await ejecutarRetencion(e);

    expect(report.dryRun).toBe(true);
    expect(report.totalBorrados).toBeGreaterThan(0); // dice qué borraría...
    expect(await telefonoSobrevive(e)).not.toHaveLength(0); // ...pero no borró
    expect((await e.auditLog.readAll())).toHaveLength(1);
    expect(await e.lastInteractionStore.get(TELEFONO)).not.toBeNull();
  });
});

describe("ejecutarRetencion — borrado real", () => {
  it("un lead vencido no deja rastro en NINGÚN store (borrado parejo)", async () => {
    // El modo de fallo #2 del pre-mortem: purgar un store y dejar el mismo
    // teléfono vivo en otro daría apariencia de cumplimiento sin cumplir.
    const e = escenario();
    await sembrarLeadViejo(e, 30);

    await ejecutarRetencion(e);

    expect(await telefonoSobrevive(e)).toEqual([]);
  });

  it("no toca datos recientes", async () => {
    const e = escenario();
    await sembrarLeadViejo(e, 1);

    const report = await ejecutarRetencion(e);

    expect(report.totalBorrados).toBe(0);
    expect(await telefonoSobrevive(e)).not.toHaveLength(0);
  });

  it("aplica los dos plazos por separado: a los 18 meses purga mensajes/logs pero conserva gestión comercial", async () => {
    // Es el caso que motivó el store de última interacción: el audit se va a
    // los 12 meses, pero la visita tiene que sobrevivir hasta los 24.
    const e = escenario();
    await sembrarLeadViejo(e, 18);

    await ejecutarRetencion(e);

    expect(await e.auditLog.readAll()).toHaveLength(0);
    expect(await e.conversationStateStore.get(TELEFONO)).toBeNull();
    expect((await e.appointmentStore.ultimaVisitaPorLead())[TELEFONO]).toBeDefined();
    expect(await e.recontactStateStore.get(TELEFONO)).not.toBeNull();
  });

  it("un lead que volvió hace poco conserva su visita vieja (no se pierde el lead que reaparece)", async () => {
    // El caso que planteó el dueño del repo: alguien que consultó hace 14
    // meses y vuelve. La visita vieja NO se purga porque la última
    // interacción es reciente.
    const e = escenario();
    await sembrarLeadViejo(e, 30);
    await e.lastInteractionStore.record(TELEFONO, new Date(haceMeses(1)));

    await ejecutarRetencion(e);

    expect((await e.appointmentStore.ultimaVisitaPorLead())[TELEFONO]).toBeDefined();
    expect(await e.recontactStateStore.get(TELEFONO)).not.toBeNull();
    // Los mensajes viejos igual se purgan: ese plazo es de 12 meses y corre aparte.
    expect(await e.auditLog.readAll()).toHaveLength(0);
  });
});

describe("ejecutarRetencion — el reporte", () => {
  it("queda persistido, con el corte usado y una muestra de qué cayó", async () => {
    const e = escenario();
    await sembrarLeadViejo(e, 30);

    const report = await ejecutarRetencion(e);
    const guardados = await e.reportStore.readAll();

    expect(guardados).toHaveLength(1);
    expect(guardados[0].id).toBe(report.id);
    expect(report.cutoffMensajes).toBeTruthy();
    expect(report.cutoffGestionComercial).toBeTruthy();
    expect(report.muestra.length).toBeGreaterThan(0);
    expect(report.borradosPorStore.audit_log).toBe(1);
  });

  it("nunca incluye el texto de los mensajes ni el teléfono sin enmascarar", async () => {
    // El reporte se persiste para comparar corridas: si llevara contenido,
    // sería un archivo con exactamente los datos que este job debe borrar.
    const e = escenario();
    await sembrarLeadViejo(e, 30);

    const report = await ejecutarRetencion(e);
    const serializado = JSON.stringify(report);

    expect(serializado).not.toContain("me interesa el depto");
    expect(serializado).not.toContain(TELEFONO);
    expect(serializado).toContain("•••");
  });
});

describe("ultimaInteraccionEfectiva / leadsVencidos", () => {
  it("usa la visita más reciente como respaldo cuando el lead no tiene interacción registrada", async () => {
    // Sin este respaldo, al desplegar por primera vez el store está vacío y
    // ningún lead preexistente tendría fecha.
    const efectiva = ultimaInteraccionEfectiva({}, { [TELEFONO]: haceMeses(30) });
    expect(efectiva[TELEFONO]).toBe(haceMeses(30));
  });

  it("la interacción registrada gana si es más reciente que la última visita", async () => {
    const efectiva = ultimaInteraccionEfectiva({ [TELEFONO]: haceMeses(2) }, { [TELEFONO]: haceMeses(30) });
    expect(efectiva[TELEFONO]).toBe(haceMeses(2));
  });

  it("marca vencido solo lo anterior al corte", async () => {
    const vencidos = leadsVencidos({ viejo: haceMeses(30), nuevo: haceMeses(2) }, new Date(haceMeses(24)));
    expect([...vencidos]).toEqual(["viejo"]);
  });
});
