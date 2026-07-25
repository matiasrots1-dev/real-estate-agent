// Wrapper del endpoint gratuito "5 day / 3 hour forecast" de OpenWeatherMap
// (docs/SOW.md secc. 4.4 — tier gratuito alcanza). No usamos One Call 3.0
// porque requiere suscripción paga.

const FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast";

// Tolerancia entre la fecha pedida y el slot de pronóstico más cercano.
// El tier gratuito solo cubre ~5 días en slots de 3hs; más allá de eso no
// hay dato real y preferimos fallar explícito antes que devolver un slot
// que no corresponde a la fecha pedida.
const MAX_SLOT_TOLERANCE_MS = 36 * 60 * 60 * 1000;

export interface ForecastSlot {
  timestamp: string; // ISO, el slot de pronóstico real usado (puede no coincidir exacto con la fecha pedida)
  descripcion: string;
  temperaturaC: number;
  probabilidadLluvia: number; // 0-1
}

export interface WeatherClient {
  getForecast(lat: number, lng: number, targetDate: string): Promise<ForecastSlot>;
}

interface OpenWeatherMapListEntry {
  dt_txt: string;
  main: { temp: number };
  weather: Array<{ description: string }>;
  pop?: number;
}

interface OpenWeatherMapForecastResponse {
  list: OpenWeatherMapListEntry[];
}

export function pickClosestSlot(
  list: OpenWeatherMapListEntry[],
  targetDate: string
): ForecastSlot {
  const targetMs = new Date(targetDate).getTime();
  if (Number.isNaN(targetMs)) {
    throw new Error(`Fecha inválida: "${targetDate}"`);
  }
  if (list.length === 0) {
    throw new Error("OpenWeatherMap no devolvió ningún slot de pronóstico.");
  }

  let closest = list[0];
  let closestDiffMs = Math.abs(new Date(closest.dt_txt).getTime() - targetMs);
  for (const entry of list.slice(1)) {
    const diffMs = Math.abs(new Date(entry.dt_txt).getTime() - targetMs);
    if (diffMs < closestDiffMs) {
      closest = entry;
      closestDiffMs = diffMs;
    }
  }

  if (closestDiffMs > MAX_SLOT_TOLERANCE_MS) {
    throw new Error(
      `La fecha solicitada (${targetDate}) está fuera del rango de pronóstico disponible (el tier gratuito de OpenWeatherMap cubre ~5 días).`
    );
  }

  return {
    timestamp: closest.dt_txt,
    descripcion: closest.weather[0]?.description ?? "sin datos",
    temperaturaC: closest.main.temp,
    probabilidadLluvia: closest.pop ?? 0,
  };
}

export class OpenWeatherMapClient implements WeatherClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async getForecast(lat: number, lng: number, targetDate: string): Promise<ForecastSlot> {
    const url = new URL(FORECAST_URL);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("appid", this.apiKey);
    url.searchParams.set("units", "metric");
    url.searchParams.set("lang", "es");

    const res = await this.fetchFn(url.toString());
    if (!res.ok) {
      throw new Error(`OpenWeatherMap respondió ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as OpenWeatherMapForecastResponse;
    return pickClosestSlot(body.list, targetDate);
  }
}
