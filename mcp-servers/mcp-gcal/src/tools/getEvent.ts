import { z } from "zod";
import type { CalendarClient } from "../calendarClient.js";
import { okResult, errorResult } from "./result.js";

export const getEventInputShape = {
  eventId: z.string(),
};

export function createGetEventHandler(client: CalendarClient) {
  return async ({ eventId }: { eventId: string }) => {
    try {
      return okResult(await client.getEvent(eventId));
    } catch (error) {
      return errorResult(error);
    }
  };
}
