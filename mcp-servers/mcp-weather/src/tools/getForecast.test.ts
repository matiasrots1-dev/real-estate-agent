import { describe, expect, it } from "vitest";
import { createGetForecastHandler } from "./getForecast.js";
import type { ForecastSlot, WeatherClient } from "../openWeatherMapClient.js";

class StubWeatherClient implements WeatherClient {
  constructor(private readonly result: ForecastSlot | Error) {}

  async getForecast(): Promise<ForecastSlot> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe("getForecast handler", () => {
  it("devuelve el forecast como contenido de texto cuando el client responde OK", async () => {
    const forecast: ForecastSlot = {
      timestamp: "2026-07-27 15:00:00",
      descripcion: "algo de nubes",
      temperaturaC: 18.5,
      probabilidadLluvia: 0.3,
    };
    const handler = createGetForecastHandler(new StubWeatherClient(forecast));

    const result = await handler({ lat: -34.6, lng: -58.4, date: "2026-07-27T14:00:00" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text as string)).toEqual(forecast);
  });

  it("nunca inventa datos: si el client falla, devuelve isError en vez de un forecast inventado", async () => {
    const handler = createGetForecastHandler(
      new StubWeatherClient(new Error("La fecha solicitada está fuera del rango de pronóstico disponible"))
    );

    const result = await handler({ lat: -34.6, lng: -58.4, date: "2026-12-01" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/fuera del rango/);
  });
});
