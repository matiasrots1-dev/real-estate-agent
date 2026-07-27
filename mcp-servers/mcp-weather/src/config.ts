export interface WeatherConfig {
  apiKey: string;
}

/** Lee WEATHER_API_KEY del entorno. Falla explícito si falta (ver .env.example). */
export function loadWeatherConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WeatherConfig {
  const config = tryLoadWeatherConfigFromEnv(env);
  if (!config) {
    throw new Error(
      "Falta WEATHER_API_KEY en el entorno. Copiá .env.example a .env y completá la clave de OpenWeatherMap."
    );
  }
  return config;
}

/** Igual que `loadWeatherConfigFromEnv`, pero devuelve `null` en vez de lanzar si falta la clave. */
export function tryLoadWeatherConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WeatherConfig | null {
  const apiKey = env.WEATHER_API_KEY;
  return apiKey ? { apiKey } : null;
}
