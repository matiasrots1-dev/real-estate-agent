import { McpToolClient, type McpServerTarget } from "./mcpToolClient.js";

// Espeja ForecastSlot de mcp-servers/mcp-weather/src/openWeatherMapClient.ts.

export interface ForecastSlot {
  timestamp: string;
  descripcion: string;
  temperaturaC: number;
  probabilidadLluvia: number;
}

export interface WeatherQueries {
  getForecast(lat: number, lng: number, date: string): Promise<ForecastSlot>;
}

export class WeatherMcpClient implements WeatherQueries {
  private readonly client: McpToolClient;

  constructor(target: McpServerTarget) {
    this.client = new McpToolClient(target);
  }

  connect(): Promise<void> {
    return this.client.connect();
  }

  close(): Promise<void> {
    return this.client.close();
  }

  getForecast(lat: number, lng: number, date: string): Promise<ForecastSlot> {
    return this.client.callTool<ForecastSlot>("get_forecast", { lat, lng, date });
  }
}
