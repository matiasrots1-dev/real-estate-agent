import { describe, expect, it, vi } from "vitest";
import { OpenWeatherMapClient, pickClosestSlot } from "./openWeatherMapClient.js";

function fakeForecastResponse() {
  return {
    list: [
      {
        dt_txt: "2026-07-27 12:00:00",
        main: { temp: 14.2 },
        weather: [{ description: "cielo claro" }],
        pop: 0.1,
      },
      {
        dt_txt: "2026-07-27 15:00:00",
        main: { temp: 18.5 },
        weather: [{ description: "algo de nubes" }],
        pop: 0.3,
      },
    ],
  };
}

describe("pickClosestSlot", () => {
  it("elige el slot más cercano a la fecha pedida", () => {
    const slot = pickClosestSlot(fakeForecastResponse().list, "2026-07-27T14:00:00");
    expect(slot.timestamp).toBe("2026-07-27 15:00:00");
    expect(slot.temperaturaC).toBe(18.5);
    expect(slot.descripcion).toBe("algo de nubes");
    expect(slot.probabilidadLluvia).toBe(0.3);
  });

  it("rechaza una fecha fuera del rango cubierto por el tier gratuito", () => {
    expect(() => pickClosestSlot(fakeForecastResponse().list, "2026-08-15T12:00:00")).toThrow(
      /fuera del rango/
    );
  });

  it("rechaza una fecha inválida", () => {
    expect(() => pickClosestSlot(fakeForecastResponse().list, "no-es-una-fecha")).toThrow(
      /Fecha inválida/
    );
  });
});

describe("OpenWeatherMapClient", () => {
  it("arma la URL con lat/lng/appid y parsea la respuesta", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toContain("lat=-34.6");
      expect(url).toContain("lon=-58.4");
      expect(url).toContain("appid=test-key");
      return new Response(JSON.stringify(fakeForecastResponse()), { status: 200 });
    });

    const client = new OpenWeatherMapClient("test-key", fakeFetch as unknown as typeof fetch);
    const forecast = await client.getForecast(-34.6, -58.4, "2026-07-27T14:00:00");

    expect(forecast.temperaturaC).toBe(18.5);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("propaga un error legible si OpenWeatherMap responde con error", async () => {
    const fakeFetch = vi.fn(
      async () => new Response("clave inválida", { status: 401 })
    );
    const client = new OpenWeatherMapClient("bad-key", fakeFetch as unknown as typeof fetch);

    await expect(client.getForecast(-34.6, -58.4, "2026-07-27T14:00:00")).rejects.toThrow(
      /OpenWeatherMap respondió 401/
    );
  });
});
