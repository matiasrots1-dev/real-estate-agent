import { z } from "zod";
import type { WeatherClient } from "../openWeatherMapClient.js";

export const getForecastInputShape = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  date: z
    .string()
    .describe("Fecha (y opcionalmente hora) en formato ISO, ej. 2026-07-27 o 2026-07-27T15:00:00"),
};

type GetForecastInput = {
  lat: number;
  lng: number;
  date: string;
};

/** Nunca inventa un dato de clima: si el provider falla, devuelve isError en vez de un valor inventado. */
export function createGetForecastHandler(client: WeatherClient) {
  return async ({ lat, lng, date }: GetForecastInput) => {
    try {
      const forecast = await client.getForecast(lat, lng, date);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(forecast),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : "Error desconocido consultando el clima.",
          },
        ],
        isError: true,
      };
    }
  };
}
