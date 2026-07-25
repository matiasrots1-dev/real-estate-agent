import { z } from "zod";
import type { TokkoClient } from "../tokkoClient.js";
import { okResult, errorResult } from "./result.js";

export const getPropertyInputShape = {
  propertyId: z.string(),
};

export function createGetPropertyHandler(client: TokkoClient) {
  return async ({ propertyId }: { propertyId: string }) => {
    try {
      const property = await client.getProperty(propertyId);
      // null explícito: el agente debe usar fallback_if_not_found del intent
      // (docs/intent_catalog.yaml), nunca inventar una ficha.
      return okResult(property);
    } catch (error) {
      return errorResult(error);
    }
  };
}
