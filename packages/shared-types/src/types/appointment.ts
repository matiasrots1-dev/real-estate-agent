// Visita agendada contra Google Calendar (docs/intent_catalog.yaml:
// agendar_visita / reprogramar_cancelar_visita).

export type AppointmentStatus = "propuesta" | "confirmada" | "reprogramada" | "cancelada" | "realizada";

export interface Appointment {
  id: string;
  leadId: string;
  propertyId: string;
  gcalEventId?: string;
  fechaHora: string; // ISO datetime
  estado: AppointmentStatus;
  vecesReprogramada: number; // >= 2 dispara escalamiento, ver escalation_policy.md
  remindersSent: string[]; // offsets ya enviados, ej. ["-24h", "-2h"]
}
