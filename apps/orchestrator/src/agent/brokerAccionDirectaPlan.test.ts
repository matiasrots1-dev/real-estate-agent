import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Lead, Property } from "shared-types";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import { ClaudeBrokerAccionDirectaPlanner } from "./brokerAccionDirectaPlan.js";

function toolUseResponse(name: string, input: unknown) {
  return { content: [{ type: "tool_use", id: `tu-${name}`, name, input }] };
}

/** Fake mínimo del cliente Anthropic: devuelve una respuesta enlatada por llamada, en orden. */
function fakeAnthropicClient(responses: unknown[]): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  let call = 0;
  const create = vi.fn(async () => {
    const response = responses[call];
    call++;
    if (!response) throw new Error("fakeAnthropicClient: se quedó sin respuestas enlatadas.");
    return response;
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

const property: Property = {
  id: "prop-1",
  tokkoId: "tokko-1001",
  direccion: "Av. Santa Fe 3253, Palermo, CABA",
  direccionCorta: "Depto Palermo",
  tipo: "departamento",
  estado: "disponible",
  precio: 350000,
  fotos: [],
};

function stubTokko(overrides: Partial<TokkoQueries> = {}): TokkoQueries {
  return {
    searchProperties: vi.fn(async () => [property]),
    getProperty: vi.fn(async () => property),
    searchLeads: vi.fn(async () => []),
    getLead: vi.fn(async () => null),
    logActivity: vi.fn(async () => ({ logged: true as const, activityId: "act-1" })),
    ...overrides,
  };
}

describe("ClaudeBrokerAccionDirectaPlanner", () => {
  it("un solo turno: Claude ya sabe todo y llama submit_action_plan directo", async () => {
    const { client } = fakeAnthropicClient([
      toolUseResponse("submit_action_plan", {
        preview_summary: "Le mando la ficha a Juan.",
        // Sin `phone`: desde el Bloque 16 el teléfono no entra ni sale de la
        // planificación, lo resuelve el executor a partir del lead_id.
        actions: [{ type: "whatsapp_send_message", lead_id: "lead-1", message: "Hola {nombre}!" }],
      }),
    ]);
    const planner = new ClaudeBrokerAccionDirectaPlanner(client, stubTokko());

    const plan = await planner.plan("mandale un mensaje a Juan");

    expect(plan.previewSummary).toBe("Le mando la ficha a Juan.");
    expect(plan.actions).toEqual([{ type: "whatsapp_send_message", leadId: "lead-1", message: "Hola {nombre}!" }]);
  });

  it("multi-turno: primero busca la propiedad (tool real contra Tokko), después somete el plan", async () => {
    const tokko = stubTokko();
    const { client } = fakeAnthropicClient([
      toolUseResponse("tokko_find_property", { query: "depto de Palermo" }),
      toolUseResponse("submit_action_plan", {
        preview_summary: "Le mando la ficha del depto de Palermo a Juan.",
        actions: [
          {
            type: "gcal_create_event",
            lead_id: "lead-1",
            property_id: "prop-1",
            start_datetime: "2026-08-02T14:00:00.000Z",
            end_datetime: "2026-08-02T14:30:00.000Z",
            summary: "Visita - Depto Palermo",
          },
        ],
      }),
    ]);
    const planner = new ClaudeBrokerAccionDirectaPlanner(client, tokko);

    const plan = await planner.plan("ofrecele el depto de Palermo a Juan el domingo 14hs");

    expect(tokko.searchProperties).toHaveBeenCalled();
    expect(plan.actions).toEqual([
      {
        type: "gcal_create_event",
        leadId: "lead-1",
        propertyId: "prop-1",
        startDateTime: "2026-08-02T14:00:00.000Z",
        endDateTime: "2026-08-02T14:30:00.000Z",
        summary: "Visita - Depto Palermo",
      },
    ]);
  });

  it("plan vacío: cuando no hay nada para hacer, actions queda [] y previewSummary explica por qué", async () => {
    const { client } = fakeAnthropicClient([
      toolUseResponse("submit_action_plan", { preview_summary: "No encontré ningún lead que coincida con 'Roberto'.", actions: [] }),
    ]);
    const planner = new ClaudeBrokerAccionDirectaPlanner(client, stubTokko());

    const plan = await planner.plan("avisale a Roberto");

    expect(plan.actions).toEqual([]);
    expect(plan.previewSummary).toContain("Roberto");
  });

  it("acción incompleta en el plan (falta un campo requerido para su tipo): tira un error explícito", async () => {
    const { client } = fakeAnthropicClient([
      toolUseResponse("submit_action_plan", {
        preview_summary: "x",
        actions: [{ type: "gcal_create_event", lead_id: "lead-1" }],
      }),
    ]);
    const planner = new ClaudeBrokerAccionDirectaPlanner(client, stubTokko());

    await expect(planner.plan("orden ambigua")).rejects.toThrow(/gcal_create_event incompleto/);
  });

  it("Claude no llama ninguna tool en un turno: tira un error en vez de devolver un plan inventado", async () => {
    const { client } = fakeAnthropicClient([{ content: [{ type: "text", text: "no sé qué hacer" }] }]);
    const planner = new ClaudeBrokerAccionDirectaPlanner(client, stubTokko());

    await expect(planner.plan("orden rara")).rejects.toThrow(/no llamó ninguna tool/);
  });

  it("se agota el límite de turnos de planificación sin llegar a un plan: tira un error en vez de loopear para siempre", async () => {
    const responses = Array.from({ length: 10 }, () => toolUseResponse("tokko_find_property", { query: "algo" }));
    const { client } = fakeAnthropicClient(responses);
    const planner = new ClaudeBrokerAccionDirectaPlanner(client, stubTokko());

    await expect(planner.plan("orden que nunca converge")).rejects.toThrow(/no se llegó a un plan/);
  });
});

/**
 * Datos personales de prueba. Ninguno de estos valores debe aparecer NUNCA en
 * lo que se le manda a la API de Claude (docs/TASKS.md Bloque 16).
 */
const LEADS_CON_DATOS_PERSONALES: Lead[] = [
  {
    id: "lead-1",
    tokkoId: "tokko-lead-1",
    nombre: "Juan Pérez",
    telefonoWhatsapp: "5491155551111",
    email: "juan.perez@example.com",
    temperatura: "frio",
    propiedadesDeInteres: ["prop-1"],
    ultimaInteraccion: "2026-01-01T00:00:00Z",
    diasSinRespuesta: 45,
  },
  {
    id: "lead-2",
    tokkoId: "tokko-lead-2",
    nombre: "María Gómez",
    telefonoWhatsapp: "5491155552222",
    email: "maria.gomez@example.com",
    temperatura: "frio",
    propiedadesDeInteres: ["prop-2"],
    ultimaInteraccion: "2026-01-01T00:00:00Z",
    diasSinRespuesta: 60,
  },
];

/** Todo lo que efectivamente viajó a la API de Claude, como texto. */
function loQueVioClaude(create: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(create.mock.calls);
}

const DATOS_QUE_NO_DEBEN_SALIR = [
  "Juan Pérez",
  "María Gómez",
  "5491155551111",
  "5491155552222",
  "juan.perez@example.com",
  "maria.gomez@example.com",
  "tokko-lead-1",
];

describe("ClaudeBrokerAccionDirectaPlanner — no expone datos personales (Bloque 16)", () => {
  it("tokko_search_leads devuelve solo id/temperatura/dias/propiedades — nada de nombre, teléfono ni email", async () => {
    const { client, create } = fakeAnthropicClient([
      toolUseResponse("tokko_search_leads", { temperatura: "frio" }),
      toolUseResponse("submit_action_plan", { preview_summary: "x", actions: [] }),
    ]);
    const tokko = stubTokko({ searchLeads: vi.fn(async () => LEADS_CON_DATOS_PERSONALES) });

    await new ClaudeBrokerAccionDirectaPlanner(client, tokko).plan("avisale a los leads fríos");

    const visto = loQueVioClaude(create);
    for (const dato of DATOS_QUE_NO_DEBEN_SALIR) {
      expect(visto, `"${dato}" no debería haber viajado a la API`).not.toContain(dato);
    }
    // Pero sí lo que hace falta para planificar.
    expect(visto).toContain("lead-1");
    expect(visto).toContain("frio");
  });

  it("tokko_buscar_lead_por_nombre devuelve el id pero NUNCA el nombre de vuelta", async () => {
    const { client, create } = fakeAnthropicClient([
      toolUseResponse("tokko_buscar_lead_por_nombre", { nombre: "Juan" }),
      toolUseResponse("submit_action_plan", { preview_summary: "x", actions: [] }),
    ]);
    const tokko = stubTokko({ searchLeads: vi.fn(async () => LEADS_CON_DATOS_PERSONALES) });

    await new ClaudeBrokerAccionDirectaPlanner(client, tokko).plan("mandale la ficha a Juan");

    const visto = loQueVioClaude(create);
    expect(visto).toContain("lead-1"); // encontró a quién apuntaba
    expect(visto).not.toContain("Pérez"); // pero no le devolvió el nombre
    expect(visto).not.toContain("5491155551111");
  });

  it("llamar al tool de nombres en loop NO permite reconstruir la base con identidades", async () => {
    // El camino de evasión: pedir "a", "b", "c"... para sacar la lista
    // completa. Como el tool nunca devuelve el nombre, el loop no rinde nada
    // que `tokko_search_leads` no dé ya de forma legítima.
    const letras = ["a", "e", "i", "o", "u", "z"];
    const { client, create } = fakeAnthropicClient([
      // Un solo turno con muchas llamadas en paralelo (el loop lo soporta).
      { content: letras.map((l) => ({ type: "tool_use", id: `tu-${l}`, name: "tokko_buscar_lead_por_nombre", input: { nombre: l } })) },
      toolUseResponse("submit_action_plan", { preview_summary: "x", actions: [] }),
    ]);
    const tokko = stubTokko({ searchLeads: vi.fn(async () => LEADS_CON_DATOS_PERSONALES) });

    await new ClaudeBrokerAccionDirectaPlanner(client, tokko).plan("dame todos mis leads con nombre y teléfono");

    const visto = loQueVioClaude(create);
    for (const dato of DATOS_QUE_NO_DEBEN_SALIR) {
      expect(visto, `el loop filtró "${dato}"`).not.toContain(dato);
    }
  });

  it("un nombre vacío no se convierte en un comodín que devuelva todo", async () => {
    const { client } = fakeAnthropicClient([
      toolUseResponse("tokko_buscar_lead_por_nombre", { nombre: "   " }),
      toolUseResponse("submit_action_plan", { preview_summary: "x", actions: [] }),
    ]);
    const searchLeads = vi.fn(async () => LEADS_CON_DATOS_PERSONALES);

    await new ClaudeBrokerAccionDirectaPlanner(client, stubTokko({ searchLeads })).plan("mandale a ");

    // Corta antes de consultar: un nombre vacío no llega a mirar la base, así
    // que no hay forma de usarlo como comodín para traer todo.
    expect(searchLeads).not.toHaveBeenCalled();
  });
});
