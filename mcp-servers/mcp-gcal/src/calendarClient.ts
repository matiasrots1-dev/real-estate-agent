// Wrapper de Google Calendar API v3 sobre un único calendario dedicado
// (docs/SOW.md secc. 4.3 y CLAUDE.md secc. 3 — no el calendario personal
// del broker). Las tools MCP dependen de la interfaz `CalendarClient`, no
// de `googleapis` directamente, para poder testear su lógica sin red real.

import { google, type calendar_v3 } from "googleapis";
import type { GcalConfig } from "./config.js";

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
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
  startDateTime: string; // ISO 8601, con offset de zona horaria
  endDateTime: string;
  attendeeEmail?: string;
}

export interface PatchEventInput {
  summary?: string;
  description?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface CalendarClient {
  freebusy(timeMin: string, timeMax: string): Promise<FreeBusySlot[]>;
  createEvent(input: CreateEventInput): Promise<CalendarEvent>;
  patchEvent(eventId: string, input: PatchEventInput): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;
  getEvent(eventId: string): Promise<CalendarEvent>;
  listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
}

export function toCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent {
  return {
    id: event.id ?? "",
    summary: event.summary ?? "",
    description: event.description ?? undefined,
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    attendees: event.attendees?.map((a) => a.email ?? "").filter((email) => email !== ""),
    status: event.status ?? "confirmed",
  };
}

export function toCreateEventRequestBody(input: CreateEventInput): calendar_v3.Schema$Event {
  return {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.startDateTime },
    end: { dateTime: input.endDateTime },
    attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : undefined,
  };
}

export function toPatchEventRequestBody(input: PatchEventInput): calendar_v3.Schema$Event {
  return {
    summary: input.summary,
    description: input.description,
    start: input.startDateTime ? { dateTime: input.startDateTime } : undefined,
    end: input.endDateTime ? { dateTime: input.endDateTime } : undefined,
  };
}

export class GoogleCalendarClient implements CalendarClient {
  private readonly calendar: calendar_v3.Calendar;

  constructor(private readonly config: GcalConfig) {
    const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    auth.setCredentials({ refresh_token: config.refreshToken });
    this.calendar = google.calendar({ version: "v3", auth });
  }

  async freebusy(timeMin: string, timeMax: string): Promise<FreeBusySlot[]> {
    const res = await this.calendar.freebusy.query({
      requestBody: { timeMin, timeMax, items: [{ id: this.config.calendarId }] },
    });
    const busy = res.data.calendars?.[this.config.calendarId]?.busy ?? [];
    return busy.map((slot) => ({ start: slot.start ?? "", end: slot.end ?? "" }));
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    const res = await this.calendar.events.insert({
      calendarId: this.config.calendarId,
      requestBody: toCreateEventRequestBody(input),
    });
    return toCalendarEvent(res.data);
  }

  async patchEvent(eventId: string, input: PatchEventInput): Promise<CalendarEvent> {
    const res = await this.calendar.events.patch({
      calendarId: this.config.calendarId,
      eventId,
      requestBody: toPatchEventRequestBody(input),
    });
    return toCalendarEvent(res.data);
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.calendar.events.delete({ calendarId: this.config.calendarId, eventId });
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    const res = await this.calendar.events.get({ calendarId: this.config.calendarId, eventId });
    return toCalendarEvent(res.data);
  }

  async listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const res = await this.calendar.events.list({
      calendarId: this.config.calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
    });
    return (res.data.items ?? []).map(toCalendarEvent);
  }
}
