export interface WeatherConfig {
  apiKey: string;
}

/** Lee WEATHER_API_KEY del entorno. Falla explícito si falta (ver .env.example). */
export function loadWeatherConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WeatherConfig {
  const apiKey = env.WEATHER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Falta WEATHER_API_KEY en el entorno. Copiá .env.example a .env y completá la clave de OpenWeatherMap."
    );
  }
  return { apiKey };
}
