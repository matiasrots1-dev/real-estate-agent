import { z } from "zod";
import type { CalendarClient } from "../calendarClient.js";
import { okResult, errorResult } from "./result.js";

export const patchEventInputShape = {
  eventId: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
};

type PatchEventInput = {
  eventId: string;
  summary?: string;
  description?: string;
  startDateTime?: string;
  endDateTime?: string;
};

export function createPatchEventHandler(client: CalendarClient) {
  return async ({ eventId, ...patch }: PatchEventInput) => {
    try {
      return okResult(await client.patchEvent(eventId, patch));
    } catch (error) {
      return errorResult(error);
    }
  };
}
