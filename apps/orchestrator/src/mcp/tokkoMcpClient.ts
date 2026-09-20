import type { Lead, LeadTemperature, Property } from "shared-types";
import { McpToolClient, type McpServerTarget } from "./mcpToolClient.js";

export interface TokkoPropertySearchFilters {
  barrio?: string;
  direccion?: string;
  tipo?: string;
  codigo?: string;
}

export interface TokkoLeadSearchFilters {
  temperatura?: LeadTemperature;
  diasSinRespuestaMin?: number;
  /**
   * Solo los candidatos a recontacto proactivo: el criterio que definio el
   * dueno del repo mirando la distribucion real de la cuenta (agente
   * asignado, estado distinto de "Cerrado", barrio de sus propiedades). De
   * 4683 contactos pasan 29.
   *
   * El filtro vive aca, sobre el contacto CRUDO de Tokko, y no en el
   * llamador: es lo unico que garantiza que el job que envia y el simulacro
   * que se aprueba vean la misma gente (docs/TASKS.md Bloque 27).
   */
  paraRecontacto?: boolean;
}

export interface LogActivityInput {
  leadId?: string;
  propertyId?: string;
  tipo: string;
  detalle?: string;
}

export interface LogActivityResult {
  logged: true;
  activityId: string;
}

/**
 * Lo que el agente necesita de Tokko, como interfaz — así los handlers de
 * intents (ej. consultaDisponibilidad.ts) se testean con un stub en vez de
 * depender de la conexión MCP real por stdio.
 */
export interface TokkoQueries {
  searchProperties(filters: TokkoPropertySearchFilters): Promise<Property[]>;
  getProperty(propertyId: string): Promise<Property | null>;
  searchLeads(filters: TokkoLeadSearchFilters): Promise<Lead[]>;
  getLead(leadId: string): Promise<Lead | null>;
  logActivity(input: LogActivityInput): Promise<LogActivityResult>;
}

/** Wrapper tipado de las tools de mcp-tokko que usa el loop del agente. */
export class TokkoMcpClient implements TokkoQueries {
  private readonly client: McpToolClient;

  constructor(target: McpServerTarget) {
    this.client = new McpToolClient(target);
  }

  connect(): Promise<void> {
    return this.client.connect();
  }

  close(): Promise<void> {
    return this.client.close();
  }

  /**
   * Qué fuente de datos está usando el server MCP. Deliberadamente **no** está
   * en la interfaz `TokkoQueries`: es diagnóstico, no algo con lo que el
   * agente decida nada.
   */
  fuenteDatos(): Promise<{ fuente: string; branchId: number | null }> {
    return this.client.callTool("tokko_fuente_datos", {});
  }

  searchProperties(filters: TokkoPropertySearchFilters): Promise<Property[]> {
    return this.client.callTool<Property[]>("search_properties", filters);
  }

  getProperty(propertyId: string): Promise<Property | null> {
    return this.client.callTool<Property | null>("get_property", { propertyId });
  }

  searchLeads(filters: TokkoLeadSearchFilters): Promise<Lead[]> {
    return this.client.callTool<Lead[]>("search_leads", filters);
  }

  getLead(leadId: string): Promise<Lead | null> {
    return this.client.callTool<Lead | null>("get_lead", { leadId });
  }

  logActivity(input: LogActivityInput): Promise<LogActivityResult> {
    return this.client.callTool<LogActivityResult>("log_activity", input);
  }
}
