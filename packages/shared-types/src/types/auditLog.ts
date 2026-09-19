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
  /**
   * Id de Meta del mensaje entrante (`wamid`). Vincula la entrada `recibido`
   * con la que resuelve el mismo mensaje (docs/TASKS.md Bloque 34). Ausente en
   * las entradas anteriores a ese bloque y en las de los jobs, que no responden
   * a un mensaje entrante.
   */
  messageId?: string;
  /**
   * `recibido`: escrita al llegar el mensaje, antes de clasificar.
   * `fallido`: el procesamiento tiró; al cliente no se le respondió nada.
   * Ausente: entrada resuelta, como todas las anteriores al Bloque 34.
   */
  etapa?: "recibido" | "fallido";
  /**
   * Qué pasó con el aviso al broker, en las entradas que lo intentaron
   * (docs/TASKS.md Bloque 38a):
   * - `enviado`: con borrador. WhatsApp lo aceptó, lo que no garantiza que
   *   llegue (ventana de 24 hs, Bloque 38).
   * - `sin_borrador`: el borrador falló y el aviso salió sin él.
   * - `fallo`: el aviso no se pudo mandar. El broker no se enteró por
   *   WhatsApp.
   * Ausente: no hubo aviso, o la entrada es anterior al Bloque 38a.
   */
  avisoAlBroker?: "enviado" | "sin_borrador" | "fallo";
}
