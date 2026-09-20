import { describe, expect, it } from "vitest";
import { InMemoryAuditLogStore } from "../agent/auditLog.js";
import { InMemoryAppointmentStore } from "../agent/appointmentStore.js";
import { InMemoryConversationStateStore, idleState } from "../agent/conversationStateStore.js";
import { InMemoryRecontactStateStore } from "../agent/recontactStateStore.js";
import { InMemoryLastInteractionStore } from "../agent/lastInteractionStore.js";
import { InMemoryRetentionReportStore } from "../agent/retentionReportStore.js";
import {
  createRetentionJob,
  debeCorrerRetencion,
  ejecutarRetencion,
  leadsVencidos,
  ultimaInteraccionEfectiva,
  type RetentionJobDeps,
} from "./retention.js";

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

// docs/TASKS.md Bloque 40. La retención pasa a correr una vez por día, en
// horario tranquilo. El modo de fallo que domina el diseño es el 1: si deja
// de correr, el síntoma es silencio — exactamente lo mismo que se ve cuando
// corre y no borra nada, que es lo que pasa hoy y va a pasar hasta julio de
// 2027.
describe("debeCorrerRetencion", () => {
  const aLas = (hora: number, dia = 15) => new Date(`2027-06-${dia}T${String(hora).padStart(2, "0")}:00:00`);

  it("antes de la hora del día, no le toca", () => {
    expect(debeCorrerRetencion({ ultima: null, ahora: aLas(3), hora: 4 })).toBe(false);
  });

  it("pasada la hora y sin corridas previas, corre", () => {
    expect(debeCorrerRetencion({ ultima: null, ahora: aLas(4), hora: 4 })).toBe(true);
  });

  it("si ya corrió hoy después de la hora, no vuelve a correr", () => {
    expect(debeCorrerRetencion({ ultima: aLas(4), ahora: aLas(12), hora: 4 })).toBe(false);
  });

  it("si la última fue ayer, corre", () => {
    expect(debeCorrerRetencion({ ultima: aLas(4, 14), ahora: aLas(4), hora: 4 })).toBe(true);
  });

  // Modo de fallo 1: con la condición "es tal hora", un proceso caído durante
  // esa vuelta —o un deploy justo ahí— se saltea el día entero.
  it("si el proceso estuvo caído en la ventana, se pone al día cuando levanta", () => {
    expect(debeCorrerRetencion({ ultima: aLas(4, 14), ahora: aLas(23), hora: 4 })).toBe(true);
  });

  it("una corrida de ayer POSTERIOR a la hora tampoco alcanza para saltear hoy", () => {
    expect(debeCorrerRetencion({ ultima: aLas(23, 14), ahora: aLas(5), hora: 4 })).toBe(true);
  });
});

describe("createRetentionJob — corre una vez por día", () => {
  const aLas = (hora: number, dia = 15) => new Date(`2027-06-${dia}T${String(hora).padStart(2, "0")}:00:00`);

  function job(e: Escenario, ahora: () => Date, hora = 4) {
    return createRetentionJob({ ...e, now: ahora, horaDeCorrida: hora });
  }

  it("no corre antes de la hora configurada", async () => {
    const e = escenario();
    await job(e, () => aLas(3)).run();
    expect(await e.reportStore.readAll()).toHaveLength(0);
  });

  it("corre una vez y no vuelve a correr en las vueltas del mismo día", async () => {
    const e = escenario();
    let ahora = aLas(4);
    const j = job(e, () => ahora);

    await j.run();
    for (const h of [5, 6, 12, 23]) {
      ahora = aLas(h);
      await j.run();
    }

    expect(await e.reportStore.readAll()).toHaveLength(1);
  });

  it("al día siguiente vuelve a correr", async () => {
    const e = escenario();
    let ahora = aLas(4, 15);
    const j = job(e, () => ahora);

    await j.run();
    ahora = aLas(4, 16);
    await j.run();

    expect(await e.reportStore.readAll()).toHaveLength(2);
  });

  // Modo de fallo 2: la marca en memoria no sobrevive a un deploy, y el 19/09
  // hubo dos.
  it("un proceso nuevo el mismo día no la vuelve a correr: lo dice el reporte", async () => {
    const e = escenario();
    let ahora = aLas(4);
    await job(e, () => ahora).run();

    ahora = aLas(10);
    await job(e, () => ahora).run(); // otro proceso, mismo reportStore

    expect(await e.reportStore.readAll()).toHaveLength(1);
  });

  // Y el otro lado del mismo modo de fallo: guardar el reporte puede fallar
  // —ese `append` está envuelto en un catch a propósito—, y sin la marca en
  // memoria la purga volvería a correr en cada vuelta el resto del día,
  // reescribiendo el audit log entero cada 5 minutos.
  it("si el reporte no se pudo guardar, igual no corre de nuevo en el día", async () => {
    const e = escenario({
      reportStore: {
        append: async () => {
          throw new Error("ENOSPC");
        },
        readAll: async () => [],
      },
    });
    const corridas: string[] = [];
    let ahora = aLas(4);
    const j = job({ ...e, auditLog: espiaDeCorridas(e, corridas) } as Escenario, () => ahora);

    await j.run();
    ahora = aLas(10);
    await j.run();

    expect(corridas).toHaveLength(1);
  });

  it("si el reporte es ilegible, corre igual: es preferible purgar de más que no purgar", async () => {
    const e = escenario({
      reportStore: {
        append: async () => {},
        readAll: async () => {
          throw new Error("archivo ilegible");
        },
      },
    });
    const corridas: string[] = [];
    const j = job({ ...e, auditLog: espiaDeCorridas(e, corridas) } as Escenario, () => aLas(4));

    await j.run();

    expect(corridas).toHaveLength(1);
  });
});

/** Cuenta cuántas veces la purga tocó el audit log. */
function espiaDeCorridas(e: Escenario, corridas: string[]): InMemoryAuditLogStore {
  const store = e.auditLog;
  const original = store.purgeOlderThan.bind(store);
  store.purgeOlderThan = async (cutoff: Date, dryRun: boolean) => {
    corridas.push(cutoff.toISOString());
    return original(cutoff, dryRun);
  };
  return store;
}
