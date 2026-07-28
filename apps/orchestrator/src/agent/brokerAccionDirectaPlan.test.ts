import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Property } from "shared-types";
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
        actions: [{ type: "whatsapp_send_message", lead_id: "lead-1", phone: "5491100000001", message: "Hola Juan!" }],
      }),
    ]);
    const planner = new ClaudeBrokerAccionDirectaPlanner(client, stubTokko());

    const plan = await planner.plan("mandale un mensaje a Juan");

    expect(plan.previewSummary).toBe("Le mando la ficha a Juan.");
    expect(plan.actions).toEqual([{ type: "whatsapp_send_message", leadId: "lead-1", phone: "5491100000001", message: "Hola Juan!" }]);
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
