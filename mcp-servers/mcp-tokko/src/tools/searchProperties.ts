import { z } from "zod";
import type { TokkoClient, PropertySearchFilters } from "../tokkoClient.js";
import { okResult, errorResult } from "./result.js";

export const searchPropertiesInputShape = {
  barrio: z.string().optional(),
  direccion: z.string().optional(),
  tipo: z.string().optional(),
  codigo: z.string().optional(),
};

export function createSearchPropertiesHandler(client: TokkoClient) {
  return async (filters: PropertySearchFilters) => {
    try {
      return okResult(await client.searchProperties(filters));
    } catch (error) {
      return errorResult(error);
    }
  };
}
