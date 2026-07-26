// Registro de auditoría obligatorio desde el día 1 (CLAUDE.md secc. 3):
// toda respuesta del agente debe quedar registrada con qué intent matcheó,
// con qué confianza, y qué tools se llamaron.

export interface AuditLogEntry {
  id: string;
  conversationId: string;
  timestamp: string; // ISO datetime
  incomingMessage: string;
  matchedIntentId: string;
  confidence: number | null;
  toolsCalled: string[];
  escalatedToBroker: boolean;
  /** Cuál regla de docs/escalation_policy.md disparó el escalamiento (si hubo). */
  escalationRule?: "requires_broker" | "low_confidence";
  escalationReason?: string;
  responseSent?: string;
}
