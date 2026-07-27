import { describe, expect, it } from "vitest";
import { MockWeatherClient } from "./mockWeatherClient.js";

describe("MockWeatherClient", () => {
  it("es determinístico: la misma fecha/lat/lng da siempre el mismo resultado", async () => {
    const client = new MockWeatherClient();
    const a = await client.getForecast(-34.6, -58.4, "2026-08-01T15:00:00");
    const b = await client.getForecast(-34.6, -58.4, "2026-08-01T15:00:00");
    expect(a).toEqual(b);
  });

  it("da resultados distintos para fechas distintas", async () => {
    const client = new MockWeatherClient();
    const a = await client.getForecast(-34.6, -58.4, "2026-08-01T15:00:00");
    const b = await client.getForecast(-34.6, -58.4, "2026-08-15T15:00:00");
    expect(a).not.toEqual(b);
  });

  it("rechaza una fecha inválida", async () => {
    const client = new MockWeatherClient();
    await expect(client.getForecast(-34.6, -58.4, "no-es-una-fecha")).rejects.toThrow(/Fecha inválida/);
  });
});
