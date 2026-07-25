import { z } from "zod";
import type { CalendarClient } from "../calendarClient.js";
import { okResult, errorResult } from "./result.js";

export const deleteEventInputShape = {
  eventId: z.string(),
};

export function createDeleteEventHandler(client: CalendarClient) {
  return async ({ eventId }: { eventId: string }) => {
    try {
      await client.deleteEvent(eventId);
      return okResult({ deleted: true, eventId });
    } catch (error) {
      return errorResult(error);
    }
  };
}
