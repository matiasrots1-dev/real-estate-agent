import type { Intent } from "shared-types";

export type EscalationRule = "requires_broker" | "low_confidence";

export interface EscalationDecision {
  shouldEscalate: boolean;
  rule?: EscalationRule;
  reason?: string;
}

/**
 * Implementa docs/escalation_policy.md — las reglas evaluables en este
 * punto del loop (mensaje ya clasificado contra un intent, sin ejecutar
 * tools todavía):
 *
 *  1. `requires_broker: true` en el intent matcheado.
 *  3. confianza del match por debajo del `confidence_threshold` (propio
 *     del intent, o `default_confidence_threshold` si no define uno).
 *
 * Las reglas 4, 5, 6 y 8 (negociación de precio, disconformidad, términos
 * legales, pedido explícito de hablar con una persona) ya están
 * codificadas en `docs/intent_catalog.yaml` como `requires_broker: true`
 * por intent — la regla 1 las cubre sin lógica adicional acá.
 *
 * Deliberadamente NO implementadas todavía (requieren estado de
 * conversación que no existe hasta el Bloque 5 — máquina de estados):
 *  2. `requires_broker: "conditional"` — la condición puntual (ej. "es la
 *     2da reprogramación de esta visita") depende del historial.
 *  7. Acción irreversible de alto impacto — depende de la misma historia.
 *
 * Si `intent.requires_broker === "conditional"`, esta función devuelve
 * `shouldEscalate: false` a propósito: es responsabilidad del caller
 * decidir qué hacer con un intent condicional sin evaluar (hoy, tirar
 * `NotImplementedIntentError` en vez de improvisar — ver
 * `handleIncomingMessage.ts`).
 */
export function decideEscalation(
  intent: Intent,
  confidence: number,
  effectiveThreshold: number
): EscalationDecision {
  if (intent.requires_broker === true) {
    return { shouldEscalate: true, rule: "requires_broker", reason: intent.escalation_reason };
  }

  if (confidence < effectiveThreshold) {
    return {
      shouldEscalate: true,
      rule: "low_confidence",
      reason:
        intent.escalation_reason ??
        `Confianza del match (${confidence}) por debajo del umbral (${effectiveThreshold}).`,
    };
  }

  return { shouldEscalate: false };
}
