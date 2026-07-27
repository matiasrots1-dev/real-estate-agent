import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WeatherMcpClient } from "./weatherMcpClient.js";

// Integración real: spawnea mcp-weather de verdad (vía tsx) y le habla por
// stdio con el protocolo MCP real. Sin WEATHER_API_KEY configurada, cae
// solo a MockWeatherClient determinístico (ver
// mcp-servers/mcp-weather/src/server.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpWeatherDir = path.resolve(__dirname, "../../../../mcp-servers/mcp-weather");

describe("WeatherMcpClient (integración real vía stdio)", () => {
  let client: WeatherMcpClient;

  beforeAll(async () => {
    client = new WeatherMcpClient({ entryPath: path.join(mcpWeatherDir, "src/index.ts"), cwd: mcpWeatherDir });
    await client.connect();
  }, 20000);

  afterAll(async () => {
    await client.close();
  });

  it("trae un pronóstico real del proceso mcp-weather (mock determinístico adentro)", async () => {
    const forecast = await client.getForecast(-34.5875, -58.409, "2026-08-05T15:00:00.000Z");
    expect(forecast.descripcion).toBeTruthy();
    expect(typeof forecast.temperaturaC).toBe("number");
  });

  it("es determinístico entre llamadas (mismo lat/lng/fecha)", async () => {
    const a = await client.getForecast(-34.5875, -58.409, "2026-08-05T15:00:00.000Z");
    const b = await client.getForecast(-34.5875, -58.409, "2026-08-05T15:00:00.000Z");
    expect(a).toEqual(b);
  });
});
