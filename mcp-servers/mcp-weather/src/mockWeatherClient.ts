import type { ForecastSlot, WeatherClient } from "./openWeatherMapClient.js";

// TODO: reemplazar por credenciales reales de OpenWeatherMap (WEATHER_API_KEY)
// una vez que el usuario confirme el proveedor (ver CLAUDE.md secc. 5). Hasta
// entonces, este mock es lo que usa server.ts por default. El pronóstico es
// determinístico por fecha (mismo día -> mismo resultado) para que sea
// reproducible en tests/demos, no aleatorio de verdad.
const DESCRIPTIONS = ["cielo claro", "algo de nubes", "parcialmente nublado", "lluvias aisladas"];

export class MockWeatherClient implements WeatherClient {
  async getForecast(lat: number, lng: number, targetDate: string): Promise<ForecastSlot> {
    const targetMs = new Date(targetDate).getTime();
    if (Number.isNaN(targetMs)) {
      throw new Error(`Fecha inválida: "${targetDate}"`);
    }
    const seed = Math.floor(targetMs / (24 * 60 * 60 * 1000)) + Math.round(lat) + Math.round(lng);
    const index = ((seed % DESCRIPTIONS.length) + DESCRIPTIONS.length) % DESCRIPTIONS.length;
    return {
      timestamp: new Date(targetMs).toISOString(),
      descripcion: DESCRIPTIONS[index],
      temperaturaC: 15 + (Math.abs(seed) % 15),
      probabilidadLluvia: index === DESCRIPTIONS.length - 1 ? 0.6 : 0.1,
    };
  }
}
