import { z } from "zod";
import type { CalendarClient } from "../calendarClient.js";
import { okResult, errorResult } from "./result.js";

export const freebusyInputShape = {
  timeMin: z.string().describe("Inicio del rango a consultar, ISO 8601"),
  timeMax: z.string().describe("Fin del rango a consultar, ISO 8601"),
};

export function createFreebusyHandler(client: CalendarClient) {
  return async ({ timeMin, timeMax }: { timeMin: string; timeMax: string }) => {
    try {
      return okResult(await client.freebusy(timeMin, timeMax));
    } catch (error) {
      return errorResult(error);
    }
  };
}
