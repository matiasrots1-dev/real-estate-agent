import { z } from "zod";
import type { TokkoClient } from "../tokkoClient.js";
import { okResult, errorResult } from "./result.js";

export const logActivityInputShape = {
  leadId: z.string().optional(),
  propertyId: z.string().optional(),
  tipo: z.string().describe('Ej. "visita_agendada", "consulta_respondida_por_bot"'),
  detalle: z.string().optional(),
};

type LogActivityInput = {
  leadId?: string;
  propertyId?: string;
  tipo: string;
  detalle?: string;
};

export function createLogActivityHandler(client: TokkoClient) {
  return async (input: LogActivityInput) => {
    try {
      return okResult(await client.logActivity(input));
    } catch (error) {
      return errorResult(error);
    }
  };
}
