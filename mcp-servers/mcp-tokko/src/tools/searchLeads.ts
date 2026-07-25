import { z } from "zod";
import type { TokkoClient, LeadSearchFilters } from "../tokkoClient.js";
import { okResult, errorResult } from "./result.js";

export const searchLeadsInputShape = {
  temperatura: z.enum(["nuevo", "tibio", "frio"]).optional(),
  diasSinRespuestaMin: z.number().optional(),
};

export function createSearchLeadsHandler(client: TokkoClient) {
  return async (filters: LeadSearchFilters) => {
    try {
      return okResult(await client.searchLeads(filters));
    } catch (error) {
      return errorResult(error);
    }
  };
}
