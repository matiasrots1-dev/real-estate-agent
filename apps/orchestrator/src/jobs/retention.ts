import { randomUUID } from "node:crypto";
import type { AuditLogStore } from "../agent/auditLog.js";
import type { AppointmentStore } from "../agent/appointmentStore.js";
import type { ConversationStateStore } from "../agent/conversationStateStore.js";
import type { RecontactStateStore } from "../agent/recontactStateStore.js";
import type { LastInteractionStore } from "../agent/lastInteractionStore.js";
import type { RetentionReportStore, RetentionReport } from "../agent/retentionReportStore.js";
import { combinar, type PurgeResult } from "../agent/purge.js";
import type { ScheduledJob } from "./scheduler.js";

/**
 * Purgado por retención (docs/TASKS.md Bloque 15). Implementa la política de
 * privacidad publicada de la app:
 *
 *   - mensajes y logs .................. 12 meses
 *   - datos de gestión comercial ....... mientras dure la relación comercial,
 *     (visitas, recontactos)            operacionalizado como 24 meses desde
 *                                       la última interacción de ese lead
 *
 * **Por qué existe `LastInteractionStore` y no se calcula del `audit_log`**:
 * el audit se purga a los 12 meses, así que a partir del mes 13 ya no
 * alcanza para distinguir "este lead nunca interactuó" de "interactuó antes
 * de lo que recuerdo" — y las visitas no se purgarían nunca. La última
 * interacción se guarda como dato propio para desacoplar los dos plazos.
 *
 * **Por qué arranca sin borrar**: el borrado es irreversible y no hay backup
 * de los JSON. Por default corre en modo reporte (`dryRun`), dejando por
 * escrito qué borraría, y hace falta habilitarlo explícitamente para que
 * borre de verdad. Mismo criterio que el gate de confirmación de
 * `broker_accion_directa`: nunca lo irreversible sin un OK explícito.
 */
export interface RetentionJobDeps {
  auditLog: AuditLogStore;
  conversationStateStore: ConversationStateStore;
  appointmentStore: AppointmentStore;
  recontactStateStore: RecontactStateStore;
  lastInteractionStore: LastInteractionStore;
  reportStore: RetentionReportStore;
  /** Meses para mensajes y logs (audit_log, conversaciones). */
  mesesMensajes: number;
  /** Meses desde la última interacción para datos de gestión comercial. */
  mesesGestionComercial: number;
  /** `false` (default en config) = solo reporta, no borra. */
  borradoHabilitado: boolean;
  now?: () => Date;
}

function restarMeses(desde: Date, meses: number): Date {
  const d = new Date(desde.getTime());
  d.setMonth(d.getMonth() - meses);
  return d;
}

/**
 * Última interacción efectiva de cada lead: la del `LastInteractionStore` y,
 * como respaldo, la visita más reciente. El respaldo es lo que hace que esto
 * funcione en el primer despliegue, cuando el store todavía está vacío y
 * ningún lead preexistente tendría fecha.
 */
export function ultimaInteraccionEfectiva(
  ...fuentes: Record<string, string>[]
): Record<string, string> {
  const efectiva: Record<string, string> = {};
  for (const fuente of fuentes) {
    for (const [leadId, fecha] of Object.entries(fuente)) {
      const actual = efectiva[leadId];
      if (!actual || new Date(fecha).getTime() > new Date(actual).getTime()) {
        efectiva[leadId] = fecha;
      }
    }
  }
  return efectiva;
}

export function leadsVencidos(efectiva: Record<string, string>, cutoff: Date): Set<string> {
  const corte = cutoff.getTime();
  const vencidos = new Set<string>();
  for (const [leadId, fecha] of Object.entries(efectiva)) {
    if (new Date(fecha).getTime() < corte) vencidos.add(leadId);
  }
  return vencidos;
}

export async function ejecutarRetencion(deps: RetentionJobDeps): Promise<RetentionReport> {
  const ahora = (deps.now ?? (() => new Date()))();
  const dryRun = !deps.borradoHabilitado;
  const cutoffMensajes = restarMeses(ahora, deps.mesesMensajes);
  const cutoffGestion = restarMeses(ahora, deps.mesesGestionComercial);

  // 1. Qué leads vencieron. Se calcula ANTES de purgar el audit_log, aunque
  //    la fecha venga del LastInteractionStore — mantener este orden hace que
  //    el cálculo no dependa nunca de datos que esta misma corrida está por
  //    borrar.
  //    Se toma el MÁXIMO de todas las señales disponibles, así una señal
  //    vieja (un recontacto que mandamos hace 2 años) nunca acorta la
  //    retención de un lead que volvió hace poco.
  const efectiva = ultimaInteraccionEfectiva(
    await deps.lastInteractionStore.all(),
    await deps.appointmentStore.ultimaVisitaPorLead(),
    await deps.recontactStateStore.ultimaActividadPorLead()
  );
  const vencidos = leadsVencidos(efectiva, cutoffGestion);

  // 2. Mensajes y logs: por antigüedad propia.
  const porStore: Record<string, PurgeResult> = {
    audit_log: await deps.auditLog.purgeOlderThan(cutoffMensajes, dryRun),
    conversations: await deps.conversationStateStore.purgeOlderThan(cutoffMensajes, dryRun),
    // 3. Gestión comercial: por vencimiento del lead.
    appointments: await deps.appointmentStore.purgeLeads(vencidos, cutoffGestion, dryRun),
    recontacts: await deps.recontactStateStore.purgeLeads(vencidos, cutoffGestion, dryRun),
    // 4. El propio índice de últimas interacciones también tiene el teléfono
    //    como clave, así que se purga con el mismo corte de gestión comercial.
    last_interaction: await deps.lastInteractionStore.purgeOlderThan(cutoffGestion, dryRun),
  };

  const total = combinar(Object.values(porStore));
  const report: RetentionReport = {
    id: randomUUID(),
    corridaAt: ahora.toISOString(),
    dryRun,
    cutoffMensajes: cutoffMensajes.toISOString(),
    cutoffGestionComercial: cutoffGestion.toISOString(),
    leadsVencidos: vencidos.size,
    borradosPorStore: Object.fromEntries(Object.entries(porStore).map(([k, v]) => [k, v.borrados])),
    totalBorrados: total.borrados,
    muestra: total.muestra,
  };

  await deps.reportStore.append(report);
  return report;
}

export function createRetentionJob(deps: RetentionJobDeps): ScheduledJob {
  return {
    name: "retencion_datos",
    async run(): Promise<void> {
      const report = await ejecutarRetencion(deps);
      const modo = report.dryRun ? "SIMULACRO (no se borró nada)" : "BORRADO REAL";
      console.log(
        `jobs/retention [${modo}]: ${report.totalBorrados} registros ` +
          `(${JSON.stringify(report.borradosPorStore)}), ${report.leadsVencidos} leads vencidos. ` +
          `Reporte ${report.id}.`
      );
    },
  };
}
