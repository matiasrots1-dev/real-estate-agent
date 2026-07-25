import { describe, expect, it } from "vitest";
import { MockTokkoClient } from "./mockTokkoClient.js";

describe("MockTokkoClient", () => {
  it("busca propiedades por barrio ignorando mayúsculas y acentos", async () => {
    const client = new MockTokkoClient();
    const results = await client.searchProperties({ barrio: "palermo" });
    expect(results).toHaveLength(1);
    expect(results[0].direccionCorta).toBe("Depto Palermo");
  });

  it("devuelve [] si ninguna propiedad matchea el filtro", async () => {
    const client = new MockTokkoClient();
    const results = await client.searchProperties({ barrio: "Nuñez" });
    expect(results).toEqual([]);
  });

  it("getProperty devuelve null (no inventa) si el id no existe", async () => {
    const client = new MockTokkoClient();
    const property = await client.getProperty("no-existe");
    expect(property).toBeNull();
  });

  it("getProperty encuentra por id interno o por tokkoId", async () => {
    const client = new MockTokkoClient();
    expect(await client.getProperty("prop-1")).not.toBeNull();
    expect(await client.getProperty("tokko-1001")).not.toBeNull();
  });

  it("searchLeads filtra por temperatura y días sin respuesta mínimos", async () => {
    const client = new MockTokkoClient();
    const frios = await client.searchLeads({ temperatura: "frio" });
    expect(frios).toHaveLength(1);
    expect(frios[0].nombre).toBe("María Gómez");

    const conMuchoSilencio = await client.searchLeads({ diasSinRespuestaMin: 10 });
    expect(conMuchoSilencio).toHaveLength(1);
    expect(conMuchoSilencio[0].id).toBe("lead-2");
  });

  it("getLead devuelve null si no existe", async () => {
    const client = new MockTokkoClient();
    expect(await client.getLead("no-existe")).toBeNull();
  });

  it("logActivity confirma el registro sin persistir datos reales", async () => {
    const client = new MockTokkoClient();
    const result = await client.logActivity({ leadId: "lead-1", tipo: "visita_agendada" });
    expect(result.logged).toBe(true);
    expect(result.activityId).toMatch(/^mock-activity-/);
  });
});
