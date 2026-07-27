import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenWeatherMapClient, type WeatherClient } from "./openWeatherMapClient.js";
import { MockWeatherClient } from "./mockWeatherClient.js";
import { createGetForecastHandler, getForecastInputShape } from "./tools/getForecast.js";
import { tryLoadWeatherConfigFromEnv } from "./config.js";

function defaultWeatherClient(): WeatherClient {
  const config = tryLoadWeatherConfigFromEnv();
  if (config) return new OpenWeatherMapClient(config.apiKey);
  console.warn(
    "WEATHER_API_KEY no configurada: usando MockWeatherClient determinístico (ver CLAUDE.md secc. 5)."
  );
  return new MockWeatherClient();
}

export function createServer(client?: WeatherClient): McpServer {
  const weatherClient = client ?? defaultWeatherClient();

  const server = new McpServer({ name: "mcp-weather", version: "0.1.0" });

  server.registerTool(
    "get_forecast",
    {
      title: "Pronóstico del clima",
      description:
        "Devuelve el pronóstico (temperatura, descripción, probabilidad de lluvia) para una lat/lng y fecha dadas. Usado para dar contexto en recordatorios de visitas (docs/intent_catalog.yaml: consulta_clima_visita, recordatorio_visita).",
      inputSchema: getForecastInputShape,
    },
    createGetForecastHandler(weatherClient)
  );

  return server;
}
