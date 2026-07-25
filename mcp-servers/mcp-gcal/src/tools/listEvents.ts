import { z } from "zod";
import type { CalendarClient } from "../calendarClient.js";
import { okResult, errorResult } from "./result.js";

export const listEventsInputShape = {
  timeMin: z.string().describe("Inicio del rango a listar, ISO 8601"),
  timeMax: z.string().describe("Fin del rango a listar, ISO 8601"),
};

export function createListEventsHandler(client: CalendarClient) {
  return async ({ timeMin, timeMax }: { timeMin: string; timeMax: string }) => {
    try {
      return okResult(await client.listEvents(timeMin, timeMax));
    } catch (error) {
      return errorResult(error);
    }
  };
}
