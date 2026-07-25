import { describe, expect, it, vi } from "vitest";
import type { Property, Lead } from "shared-types";
import type { TokkoClient } from "../tokkoClient.js";
import { createSearchPropertiesHandler } from "./searchProperties.js";
import { createGetPropertyHandler } from "./getProperty.js";
import { createSearchLeadsHandler } from "./searchLeads.js";
import { createGetLeadHandler } from "./getLead.js";
import { createLogActivityHandler } from "./logActivity.js";

const sampleProperty: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
};

const sampleLead: Lead = {
  id: "lead-1",
  tokkoId: "tokko-lead-1",
  nombre: "Juan Pérez",
  telefonoWhatsapp: "+5491100000001",
  temperatura: "tibio",
  propiedadesDeInteres: ["prop-1"],
  diasSinRespuesta: 2,
};

function stubClient(overrides: Partial<TokkoClient> = {}): TokkoClient {
  return {
    searchProperties: vi.fn(async () => [sampleProperty]),
    getProperty: vi.fn(async () => sampleProperty),
    searchLeads: vi.fn(async () => [sampleLead]),
    getLead: vi.fn(async () => sampleLead),
    logActivity: vi.fn(async () => ({ logged: true as const, activityId: "act-1" })),
    ...overrides,
  };
}

describe("tool handlers (client OK)", () => {
  it("search_properties delega filtros y devuelve resultados del client", async () => {
    const client = stubClient();
    const result = await createSearchPropertiesHandler(client)({ barrio: "Palermo" });
    expect(client.searchProperties).toHaveBeenCalledWith({ barrio: "Palermo" });
    expect(JSON.parse(result.content[0].text as string)).toEqual([sampleProperty]);
  });

  it("get_property devuelve null explícito sin inventar datos si no hay match", async () => {
    const client = stubClient({ getProperty: vi.fn(async () => null) });
    const result = await createGetPropertyHandler(client)({ propertyId: "no-existe" });
    expect(JSON.parse(result.content[0].text as string)).toBeNull();
  });

  it("search_leads y get_lead devuelven lo que trae el client", async () => {
    const client = stubClient();
    const searched = await createSearchLeadsHandler(client)({ temperatura: "tibio" });
    expect(JSON.parse(searched.content[0].text as string)).toEqual([sampleLead]);

    const got = await createGetLeadHandler(client)({ leadId: "lead-1" });
    expect(JSON.parse(got.content[0].text as string)).toEqual(sampleLead);
  });

  it("log_activity delega en el client y confirma el registro", async () => {
    const client = stubClient();
    const result = await createLogActivityHandler(client)({
      leadId: "lead-1",
      tipo: "visita_agendada",
    });
    expect(client.logActivity).toHaveBeenCalledWith({ leadId: "lead-1", tipo: "visita_agendada" });
    expect(JSON.parse(result.content[0].text as string)).toEqual({ logged: true, activityId: "act-1" });
  });
});

describe("tool handlers (client falla)", () => {
  it("nunca inventa una propiedad: si Tokko tira error, el handler devuelve isError", async () => {
    const client = stubClient({
      getProperty: vi.fn(async () => {
        throw new Error("Tokko API no disponible");
      }),
    });
    const result = await createGetPropertyHandler(client)({ propertyId: "prop-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no disponible/);
  });
});
