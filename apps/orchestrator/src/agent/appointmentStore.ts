import type { Appointment } from "shared-types";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface AppointmentStore {
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
}

function isActive(appointment: Appointment): boolean {
  return appointment.estado !== "cancelada" && appointment.estado !== "realizada";
}

function pickActive(appointments: Appointment[]): Appointment | null {
  const active = appointments.filter(isActive).sort((a, b) => a.fechaHora.localeCompare(b.fechaHora));
  if (active.length === 0) return null;
  const now = new Date().toISOString();
  return active.find((a) => a.fechaHora >= now) ?? active[active.length - 1];
}

export class InMemoryAppointmentStore implements AppointmentStore {
  private readonly appointments = new Map<string, Appointment>();

  async save(appointment: Appointment): Promise<void> {
    this.appointments.set(appointment.id, appointment);
  }

  async findById(id: string): Promise<Appointment | null> {
    return this.appointments.get(id) ?? null;
  }

  async findActiveByLead(leadId: string): Promise<Appointment | null> {
    return pickActive([...this.appointments.values()].filter((a) => a.leadId === leadId));
  }

  async listActive(): Promise<Appointment[]> {
    return [...this.appointments.values()].filter(isActive);
  }
}

// TODO(fase 2+): migrar a Postgres (docker-compose.yml) cuando haga falta
// concurrencia real entre procesos — este read-modify-write sobre un solo
// archivo no es seguro con requests concurrentes al mismo archivo.
export class FileAppointmentStore implements AppointmentStore {
  constructor(private readonly filePath: string) {}

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
    return pickActive(Object.values(all).filter((a) => a.leadId === leadId));
  }

  async listActive(): Promise<Appointment[]> {
    const all = await this.readAll();
    return Object.values(all).filter(isActive);
  }
}
