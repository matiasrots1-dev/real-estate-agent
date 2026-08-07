import type { Appointment } from "shared-types";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";
import { enmascararTelefono, MUESTRA_MAX, type PurgeResult, type PurgeableByLeadStore } from "./purge.js";

export interface AppointmentStore extends PurgeableByLeadStore {
  save(appointment: Appointment): Promise<void>;
  findById(id: string): Promise<Appointment | null>;
  /**
   * Simplificación deliberada del POC: un lead tiene a lo sumo una visita
   * "activa" (no cancelada/realizada) a la vez. Si en el futuro un lead
   * puede tener varias visitas en paralelo, esto necesita repensarse junto
   * con `reprogramar_cancelar_visita` (¿cuál visita reprogramás si hay más
   * de una?).
   */
  findActiveByLead(leadId: string): Promise<Appointment | null>;
  /** Todas las citas activas de todos los leads — para jobs que escanean todo (recordatorios, seguimiento post-visita). */
  listActive(): Promise<Appointment[]>;
  /** Búsqueda inversa evento de Calendar -> cita — para cruzar gcal.list_events con el lead dueño (broker_resumen_agenda). */
  findByGcalEventId(gcalEventId: string): Promise<Appointment | null>;
  /**
   * Fecha de la visita más reciente de cada lead. La usa `jobs/retention.ts`
   * como **respaldo** para calcular la última interacción cuando el
   * `LastInteractionStore` no tiene dato — que es lo que pasa con todos los
   * leads que ya existían antes de que ese store se agregara (Bloque 15).
   * Sin este respaldo, al desplegar no habría forma de fechar a nadie.
   */
  ultimaVisitaPorLead(): Promise<Record<string, string>>;
}

/**
 * Reloj inyectable (docs/TASKS.md Bloque 14). Sin esto, `pickActive` leía
 * `new Date()` directo y no había forma de testear su comportamiento en el
 * tiempo: los tests quedaban atados a la fecha real y se rompían solos con
 * el paso de los días, sin que nadie tocara nada. Mismo patrón que ya usan
 * `jobs/reminders.ts`, `jobs/recontact.ts` y `jobs/seguimientoPostVisita.ts`.
 */
export type Clock = () => Date;

const systemClock: Clock = () => new Date();

function isActive(appointment: Appointment): boolean {
  return appointment.estado !== "cancelada" && appointment.estado !== "realizada";
}

/**
 * Compara instantes, no strings. `Appointment.fechaHora` es ISO pero no
 * siempre en UTC (los slots que arma el proyecto vienen con offset
 * `-03:00`), así que comparar los strings lexicográficamente da resultados
 * incorrectos cuando los offsets difieren — ver la nota del Bloque 14.
 */
function instante(isoDateTime: string): number {
  return new Date(isoDateTime).getTime();
}

const STORE_NAME = "appointments";

function particionar(todos: Appointment[], leadIds: ReadonlySet<string>) {
  const sobreviven: Appointment[] = [];
  const muestra: PurgeResult["muestra"] = [];
  let borrados = 0;

  for (const appointment of todos) {
    if (leadIds.has(appointment.leadId)) {
      borrados++;
      if (muestra.length < MUESTRA_MAX) {
        muestra.push({
          store: STORE_NAME,
          id: appointment.id,
          fecha: appointment.fechaHora,
          lead: enmascararTelefono(appointment.leadId),
        });
      }
    } else {
      sobreviven.push(appointment);
    }
  }

  return { result: { borrados, muestra }, sobreviven };
}

function maxPorLead(appointments: Appointment[]): Record<string, string> {
  const porLead: Record<string, string> = {};
  for (const a of appointments) {
    const previa = porLead[a.leadId];
    if (!previa || instante(a.fechaHora) > instante(previa)) porLead[a.leadId] = a.fechaHora;
  }
  return porLead;
}

function pickActive(appointments: Appointment[], now: Clock): Appointment | null {
  const active = appointments.filter(isActive).sort((a, b) => instante(a.fechaHora) - instante(b.fechaHora));
  if (active.length === 0) return null;
  const ahora = now().getTime();
  return active.find((a) => instante(a.fechaHora) >= ahora) ?? active[active.length - 1];
}

export class InMemoryAppointmentStore implements AppointmentStore {
  private readonly appointments = new Map<string, Appointment>();

  constructor(private readonly now: Clock = systemClock) {}

  async save(appointment: Appointment): Promise<void> {
    this.appointments.set(appointment.id, appointment);
  }

  async findById(id: string): Promise<Appointment | null> {
    return this.appointments.get(id) ?? null;
  }

  async findActiveByLead(leadId: string): Promise<Appointment | null> {
    return pickActive([...this.appointments.values()].filter((a) => a.leadId === leadId), this.now);
  }

  async listActive(): Promise<Appointment[]> {
    return [...this.appointments.values()].filter(isActive);
  }

  async findByGcalEventId(gcalEventId: string): Promise<Appointment | null> {
    return [...this.appointments.values()].find((a) => a.gcalEventId === gcalEventId) ?? null;
  }

  async ultimaVisitaPorLead(): Promise<Record<string, string>> {
    return maxPorLead([...this.appointments.values()]);
  }

  async purgeLeads(leadIds: ReadonlySet<string>, _cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, sobreviven } = particionar([...this.appointments.values()], leadIds);
    if (!dryRun) {
      this.appointments.clear();
      for (const a of sobreviven) this.appointments.set(a.id, a);
    }
    return result;
  }
}

// TODO(fase 2+): migrar a Postgres (docker-compose.yml) cuando haga falta
// concurrencia real entre procesos — este read-modify-write sobre un solo
// archivo no es seguro con requests concurrentes al mismo archivo.
export class FileAppointmentStore implements AppointmentStore {
  constructor(
    private readonly filePath: string,
    private readonly now: Clock = systemClock
  ) {}

  private readAll(): Promise<Record<string, Appointment>> {
    return readJsonFile(this.filePath, {});
  }

  async save(appointment: Appointment): Promise<void> {
    const all = await this.readAll();
    all[appointment.id] = appointment;
    await writeJsonFile(this.filePath, all);
  }

  async findById(id: string): Promise<Appointment | null> {
    const all = await this.readAll();
    return all[id] ?? null;
  }

  async findActiveByLead(leadId: string): Promise<Appointment | null> {
    const all = await this.readAll();
    return pickActive(Object.values(all).filter((a) => a.leadId === leadId), this.now);
  }

  async listActive(): Promise<Appointment[]> {
    const all = await this.readAll();
    return Object.values(all).filter(isActive);
  }

  async findByGcalEventId(gcalEventId: string): Promise<Appointment | null> {
    const all = await this.readAll();
    return Object.values(all).find((a) => a.gcalEventId === gcalEventId) ?? null;
  }

  async ultimaVisitaPorLead(): Promise<Record<string, string>> {
    return maxPorLead(Object.values(await this.readAll()));
  }

  async purgeLeads(leadIds: ReadonlySet<string>, _cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, sobreviven } = particionar(Object.values(await this.readAll()), leadIds);
    if (!dryRun && result.borrados > 0) {
      await writeJsonFile(this.filePath, Object.fromEntries(sobreviven.map((a) => [a.id, a])));
    }
    return result;
  }
}
