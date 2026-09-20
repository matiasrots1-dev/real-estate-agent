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

  // El purgado ya pasó: si guardar el reporte falla (disco lleno, una línea
  // rota que no se pudo tolerar), la corrida no puede morir acá. Si muriera,
  // `createRetentionJob` no llegaría a loguear el resumen, y esa línea del
  // journal es el rastro que queda de un borrado (docs/TASKS.md Bloque 39).
  try {
    await deps.reportStore.append(report);
  } catch (error) {
    console.error(`jobs/retention: no se pudo guardar el reporte ${report.id}:`, error);
  }
  return report;
}

/**
 * El comienzo de la ventana de hoy: la hora tranquila a la que corre la
 * retención, en la zona horaria del servidor.
 */
function inicioDeLaVentana(ahora: Date, hora: number): Date {
  const d = new Date(ahora.getTime());
  d.setHours(hora, 0, 0, 0);
  return d;
}

/**
 * ¿Le toca correr? (docs/TASKS.md Bloque 40).
 *
 * La condición **no** es "es tal hora": si lo fuera, un proceso caído durante
 * esa vuelta —o un deploy justo ahí— saltearía el día entero, y el síntoma
 * sería silencio, igual que el de una corrida que no borró nada. Es "ya pasó
 * la hora de hoy y la última corrida es anterior a esa hora", así que en la
 * primera vuelta después de levantar se pone al día.
 */
export function debeCorrerRetencion(args: { ultima: Date | null; ahora: Date; hora: number }): boolean {
  const inicio = inicioDeLaVentana(args.ahora, args.hora);
  if (args.ahora.getTime() < inicio.getTime()) return false;
  return args.ultima === null || args.ultima.getTime() < inicio.getTime();
}

/** La corrida más reciente que quedó registrada, o `null` si no hay ninguna. */
async function ultimaCorridaDelReporte(deps: RetentionJobDeps): Promise<Date | null> {
  try {
    let ultima: number | null = null;
    for (const reporte of await deps.reportStore.readAll()) {
      const t = new Date(reporte.corridaAt).getTime();
      if (Number.isNaN(t)) continue;
      if (ultima === null || t > ultima) ultima = t;
    }
    return ultima === null ? null : new Date(ultima);
  } catch (error) {
    // Sin reporte legible no se sabe cuándo fue la última: se decide con lo
    // que recuerda el proceso. Lo peor que puede pasar es correr de más, que
    // es preferible a no purgar nunca.
    console.error("jobs/retention: no se pudo leer el reporte para saber cuándo fue la última corrida:", error);
    return null;
  }
}

export function createRetentionJob(deps: RetentionJobDeps & { horaDeCorrida: number }): ScheduledJob {
  // La última corrida de ESTE proceso. No alcanza sola —un deploy la borra, y
  // hubo dos el 19/09— pero cubre el caso en que el reporte no se pudo
  // guardar: ese `append` falla en silencio a propósito (ver arriba), y sin
  // esta marca la retención volvería a correr en cada vuelta el resto del día.
  let ultimaEnMemoria: Date | null = null;

  return {
    name: "retencion_datos",
    async run(): Promise<void> {
      const ahora = (deps.now ?? (() => new Date()))();
      const inicio = inicioDeLaVentana(ahora, deps.horaDeCorrida);

      // Si el propio proceso ya corrió dentro de la ventana de hoy, no hace
      // falta ni leer el reporte: el resto del día no cuesta nada.
      if (ultimaEnMemoria !== null && ultimaEnMemoria.getTime() >= inicio.getTime()) return;

      const delReporte = await ultimaCorridaDelReporte(deps);
      const ultima =
        ultimaEnMemoria === null || (delReporte !== null && delReporte.getTime() > ultimaEnMemoria.getTime())
          ? delReporte
          : ultimaEnMemoria;
      if (!debeCorrerRetencion({ ultima, ahora, hora: deps.horaDeCorrida })) return;

      // Se marca ANTES de purgar: si la corrida tira a la mitad, no se
      // reintenta en la vuelta siguiente. Una purga que falla se arregla
      // mirando el error, no repitiéndola cada 5 minutos sobre los mismos
      // archivos.
      ultimaEnMemoria = ahora;

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
