import { randomUUID } from "node:crypto";
import type {
  CalendarClient,
  CalendarEvent,
  CreateEventInput,
  FreeBusySlot,
  PatchEventInput,
} from "./calendarClient.js";

// TODO: reemplazar por credenciales reales de Google Calendar una vez el
// usuario confirme el calendario dedicado (ver CLAUDE.md secc. 5). Hasta
// entonces, este mock en memoria es lo que usa server.ts por default.
export class MockGoogleCalendarClient implements CalendarClient {
  private readonly events = new Map<string, CalendarEvent>();

  async freebusy(timeMin: string, timeMax: string): Promise<FreeBusySlot[]> {
    const minMs = new Date(timeMin).getTime();
    const maxMs = new Date(timeMax).getTime();
    const busy: FreeBusySlot[] = [];
    for (const event of this.events.values()) {
      if (event.status === "cancelled") continue;
      const startMs = new Date(event.start).getTime();
      const endMs = new Date(event.end).getTime();
      if (startMs < maxMs && endMs > minMs) {
        busy.push({ start: event.start, end: event.end });
      }
    }
    return busy.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    const event: CalendarEvent = {
      id: randomUUID(),
      summary: input.summary,
      description: input.description,
      start: input.startDateTime,
      end: input.endDateTime,
      attendees: input.attendeeEmail ? [input.attendeeEmail] : undefined,
      status: "confirmed",
    };
    this.events.set(event.id, event);
    return event;
  }

  async patchEvent(eventId: string, input: PatchEventInput): Promise<CalendarEvent> {
    const existing = this.mustGet(eventId);
    const patched: CalendarEvent = {
      ...existing,
      summary: input.summary ?? existing.summary,
      description: input.description ?? existing.description,
      start: input.startDateTime ?? existing.start,
      end: input.endDateTime ?? existing.end,
    };
    this.events.set(eventId, patched);
    return patched;
  }

  async deleteEvent(eventId: string): Promise<void> {
    const existing = this.mustGet(eventId);
    this.events.set(eventId, { ...existing, status: "cancelled" });
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    return this.mustGet(eventId);
  }

  async listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const minMs = new Date(timeMin).getTime();
    const maxMs = new Date(timeMax).getTime();
    return [...this.events.values()]
      .filter((event) => {
        const startMs = new Date(event.start).getTime();
        return startMs >= minMs && startMs <= maxMs;
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }

  private mustGet(eventId: string): CalendarEvent {
    const event = this.events.get(eventId);
    if (!event) {
      throw new Error(`Evento "${eventId}" no encontrado.`);
    }
    return event;
  }
}
