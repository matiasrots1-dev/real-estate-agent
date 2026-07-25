import { z } from "zod";
import type { CalendarClient } from "../calendarClient.js";
import { okResult, errorResult } from "./result.js";

export const createEventInputShape = {
  summary: z.string().describe("Título del evento, ej. \"Visita - Depto Palermo con Juan Pérez\""),
  description: z.string().optional(),
  startDateTime: z.string().describe("Inicio en ISO 8601 con offset de zona horaria"),
  endDateTime: z.string().describe("Fin en ISO 8601 con offset de zona horaria"),
  attendeeEmail: z.string().email().optional(),
};

type CreateEventInput = {
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
  attendeeEmail?: string;
};

export function createCreateEventHandler(client: CalendarClient) {
  return async (input: CreateEventInput) => {
    try {
      return okResult(await client.createEvent(input));
    } catch (error) {
      return errorResult(error);
    }
  };
}
