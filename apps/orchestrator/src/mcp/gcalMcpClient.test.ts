import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GcalMcpClient } from "./gcalMcpClient.js";

// Integración real: spawnea mcp-gcal de verdad (vía tsx) y le habla por
// stdio con el protocolo MCP real. Sin GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN
// configurados, mcp-gcal cae solo a MockGoogleCalendarClient (ver
// mcp-servers/mcp-gcal/src/server.ts) — ese mock en memoria es el dato real
// del server hasta que haya credenciales de Google Calendar.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpGcalDir = path.resolve(__dirname, "../../../../mcp-servers/mcp-gcal");

describe("GcalMcpClient (integración real vía stdio)", () => {
  let client: GcalMcpClient;

  beforeAll(async () => {
    client = new GcalMcpClient({ entryPath: path.join(mcpGcalDir, "src/index.ts"), cwd: mcpGcalDir });
    await client.connect();
  }, 20000);

  afterAll(async () => {
    await client.close();
  });

  it("crea un evento real (proceso mcp-gcal real) y lo puede leer por id", async () => {
    const created = await client.createEvent({
      summary: "Visita depto Palermo",
      startDateTime: "2026-08-05T15:00:00.000Z",
      endDateTime: "2026-08-05T15:30:00.000Z",
    });
    expect(created.id).toBeTruthy();

    const fetched = await client.getEvent(created.id);
    expect(fetched.summary).toBe("Visita depto Palermo");
  });

  it("freebusy refleja el evento recién creado", async () => {
    const created = await client.createEvent({
      summary: "Otra visita",
      startDateTime: "2026-09-01T15:00:00.000Z",
      endDateTime: "2026-09-01T15:30:00.000Z",
    });

    const busy = await client.freebusy("2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
    expect(busy.some((slot) => slot.start === created.start)).toBe(true);
  });

  it("patchEvent y deleteEvent funcionan contra el mismo proceso", async () => {
    const created = await client.createEvent({
      summary: "Visita a reprogramar",
      startDateTime: "2026-09-05T15:00:00.000Z",
      endDateTime: "2026-09-05T15:30:00.000Z",
    });

    const patched = await client.patchEvent(created.id, { startDateTime: "2026-09-06T11:00:00.000Z" });
    expect(patched.start).toBe("2026-09-06T11:00:00.000Z");

    await client.deleteEvent(created.id);
    const fetched = await client.getEvent(created.id);
    expect(fetched.status).toBe("cancelled");
  });
});
