import { z } from "zod";
import type { TokkoClient } from "../tokkoClient.js";
import { okResult, errorResult } from "./result.js";

export const getLeadInputShape = {
  leadId: z.string(),
};

export function createGetLeadHandler(client: TokkoClient) {
  return async ({ leadId }: { leadId: string }) => {
    try {
      return okResult(await client.getLead(leadId));
    } catch (error) {
      return errorResult(error);
    }
  };
}
