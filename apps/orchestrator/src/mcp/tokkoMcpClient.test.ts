import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokkoMcpClient } from "./tokkoMcpClient.js";

// Integración real: spawnea el proceso de mcp-tokko de verdad (vía tsx) y le
// habla por stdio con el protocolo MCP real. Sin mocks en esta capa — lo
// único "mock" es MockTokkoClient adentro del propio mcp-tokko, que es el
// dato real del server hasta que haya credenciales de Tokko.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpTokkoDir = path.resolve(__dirname, "../../../../mcp-servers/mcp-tokko");

describe("TokkoMcpClient (integración real vía stdio)", () => {
  let client: TokkoMcpClient;

  beforeAll(async () => {
    client = new TokkoMcpClient({
      entryPath: path.join(mcpTokkoDir, "src/index.ts"),
      cwd: mcpTokkoDir,
    });
    await client.connect();
  }, 20000);

  afterAll(async () => {
    await client.close();
  });

  it("searchProperties encuentra la propiedad mock de Palermo por dirección", async () => {
    const results = await client.searchProperties({ direccion: "Palermo" });
    expect(results).toHaveLength(1);
    expect(results[0].direccionCorta).toBe("Depto Palermo");
  });

  it("getProperty trae la ficha completa por id", async () => {
    const property = await client.getProperty("prop-1");
    expect(property).not.toBeNull();
    expect(property?.precio).toBe(350000);
  });

  it("getProperty devuelve null (no inventa) si el id no existe", async () => {
    expect(await client.getProperty("no-existe")).toBeNull();
  });

  it("searchLeads filtra por temperatura", async () => {
    const results = await client.searchLeads({ temperatura: "frio" });
    expect(results).toHaveLength(1);
    expect(results[0].nombre).toBe("María Gómez");
  });

  it("getLead trae el lead por id", async () => {
    const lead = await client.getLead("lead-1");
    expect(lead?.nombre).toBe("Juan Pérez");
  });

  it("getLead devuelve null si no existe", async () => {
    expect(await client.getLead("no-existe")).toBeNull();
  });
});
