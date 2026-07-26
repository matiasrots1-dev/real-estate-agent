import type { Property } from "shared-types";
import { McpToolClient, type McpServerTarget } from "./mcpToolClient.js";

export interface TokkoPropertySearchFilters {
  barrio?: string;
  direccion?: string;
  tipo?: string;
  codigo?: string;
}

/**
 * Lo que el agente necesita de Tokko, como interfaz — así los handlers de
 * intents (ej. consultaDisponibilidad.ts) se testean con un stub en vez de
 * depender de la conexión MCP real por stdio.
 */
export interface TokkoQueries {
  searchProperties(filters: TokkoPropertySearchFilters): Promise<Property[]>;
  getProperty(propertyId: string): Promise<Property | null>;
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

  searchProperties(filters: TokkoPropertySearchFilters): Promise<Property[]> {
    return this.client.callTool<Property[]>("search_properties", filters);
  }

  getProperty(propertyId: string): Promise<Property | null> {
    return this.client.callTool<Property | null>("get_property", { propertyId });
  }

  logActivity(input: { leadId?: string; propertyId?: string; tipo: string; detalle?: string }) {
    return this.client.callTool("log_activity", input);
  }
}
