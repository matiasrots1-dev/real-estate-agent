import { McpToolClient, type McpServerTarget } from "./mcpToolClient.js";

// Espeja las formas de mcp-servers/mcp-gcal/src/calendarClient.ts — el
// orchestrator no depende de ese paquete directamente (habla con él por
// MCP/stdio), así que estos tipos son la copia del contrato, no un import.

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  attendees?: string[];
  status: string;
}

export interface FreeBusySlot {
  start: string;
  end: string;
}

export interface CreateEventInput {
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
  attendeeEmail?: string;
}

export interface PatchEventInput {
  summary?: string;
  description?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface GcalQueries {
  freebusy(timeMin: string, timeMax: string): Promise<FreeBusySlot[]>;
  createEvent(input: CreateEventInput): Promise<CalendarEvent>;
  patchEvent(eventId: string, input: PatchEventInput): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;
  getEvent(eventId: string): Promise<CalendarEvent>;
  listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
}

export class GcalMcpClient implements GcalQueries {
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

  freebusy(timeMin: string, timeMax: string): Promise<FreeBusySlot[]> {
    return this.client.callTool<FreeBusySlot[]>("freebusy", { timeMin, timeMax });
  }

  createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    return this.client.callTool<CalendarEvent>("create_event", input);
  }

  patchEvent(eventId: string, input: PatchEventInput): Promise<CalendarEvent> {
    return this.client.callTool<CalendarEvent>("patch_event", { eventId, ...input });
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.client.callTool("delete_event", { eventId });
  }

  getEvent(eventId: string): Promise<CalendarEvent> {
    return this.client.callTool<CalendarEvent>("get_event", { eventId });
  }

  listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    return this.client.callTool<CalendarEvent[]>("list_events", { timeMin, timeMax });
  }
}
