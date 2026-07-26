import { describe, expect, it } from "vitest";
import type { Intent } from "shared-types";
import { decideEscalation } from "./escalation.js";

function intentWith(overrides: Partial<Intent>): Intent {
  return {
    id: "test_intent",
    description: "intent de prueba",
    channel: "cliente",
    priority: "normal",
    tools: [],
    requires_client_confirmation: false,
    requires_broker: false,
    confidence_threshold: 0.75,
    response: { style: "template", template: "plantilla" },
    ...overrides,
  };
}

describe("decideEscalation", () => {
  it("regla 1: requires_broker true escala siempre, sin importar la confianza", () => {
    const intent = intentWith({ requires_broker: true, escalation_reason: "motivo del catálogo" });
    const decision = decideEscalation(intent, 0.99, 0.5);
    expect(decision).toEqual({
      shouldEscalate: true,
      rule: "requires_broker",
      reason: "motivo del catálogo",
    });
  });

  it("regla 3: confianza por debajo del umbral escala aunque requires_broker sea false", () => {
    const intent = intentWith({ requires_broker: false });
    const decision = decideEscalation(intent, 0.5, 0.75);
    expect(decision.shouldEscalate).toBe(true);
    expect(decision.rule).toBe("low_confidence");
    expect(decision.reason).toMatch(/0\.5.*0\.75/);
  });

  it("usa escalation_reason del intent si lo define, incluso para baja confianza", () => {
    const intent = intentWith({ requires_broker: false, escalation_reason: "motivo específico" });
    const decision = decideEscalation(intent, 0.5, 0.75);
    expect(decision.reason).toBe("motivo específico");
  });

  it("no escala si confianza >= umbral y requires_broker es false", () => {
    const intent = intentWith({ requires_broker: false });
    expect(decideEscalation(intent, 0.9, 0.75)).toEqual({ shouldEscalate: false });
  });

  it("requires_broker \"conditional\" no escala automáticamente (queda para el caller)", () => {
    const intent = intentWith({ requires_broker: "conditional" });
    expect(decideEscalation(intent, 0.9, 0.75)).toEqual({ shouldEscalate: false });
  });

  it("confianza igual al umbral no escala (el corte es estrictamente menor que)", () => {
    const intent = intentWith({ requires_broker: false });
    expect(decideEscalation(intent, 0.75, 0.75).shouldEscalate).toBe(false);
  });
});
