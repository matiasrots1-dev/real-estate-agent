// Interfaz del wrapper de Tokko Broker API (docs/SOW.md secc. 4.2).
//
// TODO: no hay server MCP de referencia público para Tokko y todavía no se
// confirmó con el usuario el nivel de acceso de su plan (ver CLAUDE.md secc.
// 5). Por ahora la única implementación es `MockTokkoClient`. Cuando haya
// credenciales reales, agregar un `RealTokkoClient` que implemente esta
// misma interfaz contra la documentación real de la API, y validar cada
// método contra ella (dejar // TODO puntual si algún endpoint no está
// disponible en el plan del usuario).

import type { Property, Lead, LeadTemperature } from "shared-types";

export interface PropertySearchFilters {
  barrio?: string;
  direccion?: string;
  tipo?: string;
  codigo?: string;
}

export interface LeadSearchFilters {
  temperatura?: LeadTemperature;
  diasSinRespuestaMin?: number;
}

export interface LogActivityInput {
  leadId?: string;
  propertyId?: string;
  tipo: string; // ej. "visita_agendada", "consulta_respondida_por_bot"
  detalle?: string;
}

export interface LogActivityResult {
  logged: true;
  activityId: string;
}

export interface TokkoClient {
  searchProperties(filters: PropertySearchFilters): Promise<Property[]>;
  getProperty(propertyId: string): Promise<Property | null>;
  searchLeads(filters: LeadSearchFilters): Promise<Lead[]>;
  getLead(leadId: string): Promise<Lead | null>;
  logActivity(input: LogActivityInput): Promise<LogActivityResult>;
}
