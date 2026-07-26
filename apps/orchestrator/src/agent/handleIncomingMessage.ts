import { randomUUID } from "node:crypto";
import type { AuditLogEntry, IntentCatalog } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import { effectiveConfidenceThreshold, findIntent } from "./intentCatalog.js";
import type { IntentClassifier } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { AuditLogStore } from "./auditLog.js";
import { runConsultaDisponibilidad } from "./consultaDisponibilidad.js";

/**
 * El intent matcheó pero Bloque 3 todavía no tiene handler para él (ver
 * docs/TASKS.md Bloque 4/5). Se lanza en vez de improvisar una respuesta o
 * inventar datos — server.ts la atrapa y no manda nada al cliente.
 */
export class NotImplementedIntentError extends Error {
  constructor(public readonly intentId: string) {
    super(`Intent "${intentId}" matcheado pero sin handler implementado todavía.`);
    this.name = "NotImplementedIntentError";
  }
}

export interface HandleMessageDeps {
  catalog: IntentCatalog;
  classifier: IntentClassifier;
  composer: ResponseComposer;
  tokko: TokkoQueries;
  auditLog: AuditLogStore;
}

export interface HandleMessageResult {
  responseText: string;
  intentId: string;
  confidence: number;
  escalatedToBroker: boolean;
}

export async function handleIncomingMessage(
  message: IncomingWhatsAppMessage,
  deps: HandleMessageDeps
): Promise<HandleMessageResult> {
  const classification = await deps.classifier.classify(message.text, deps.catalog);
  const intent = findIntent(deps.catalog, classification.intentId);

  if (!intent) {
    throw new NotImplementedIntentError(classification.intentId);
  }

  const threshold = effectiveConfidenceThreshold(deps.catalog, intent);
  // Reglas 1 y 3 de docs/escalation_policy.md. Las reglas 2 (conditional),
  // 4-8 (señales de negociación/reclamo/legal/irreversibilidad ya
  // codificadas como requires_broker:true por intent en el catálogo, salvo
  // "conditional") quedan para agent/escalation.ts en el Bloque 4.
  const shouldEscalate = intent.requires_broker === true || classification.confidence < threshold;

  let responseText: string;
  const toolsCalled: string[] = [];

  if (shouldEscalate) {
    // TODO(Bloque 4): notificar al broker con contexto + borrador de
    // respuesta (docs/escalation_policy.md). Por ahora solo se sostiene la
    // conversación con el cliente con la plantilla del intent.
    responseText =
      intent.response.template ?? "Dejame confirmarlo con el asesor y te respondo enseguida.";
  } else if (intent.id === "consulta_disponibilidad") {
    const result = await runConsultaDisponibilidad(
      classification,
      intent,
      deps.tokko,
      deps.composer,
      deps.catalog.meta.language
    );
    responseText = result.responseText;
    toolsCalled.push(...result.toolsCalled);
  } else {
    throw new NotImplementedIntentError(intent.id);
  }

  const auditEntry: AuditLogEntry = {
    id: randomUUID(),
    conversationId: message.from,
    timestamp: new Date().toISOString(),
    incomingMessage: message.text,
    matchedIntentId: intent.id,
    confidence: classification.confidence,
    toolsCalled,
    escalatedToBroker: shouldEscalate,
    escalationReason: shouldEscalate ? intent.escalation_reason : undefined,
    responseSent: responseText,
  };
  await deps.auditLog.append(auditEntry);

  return {
    responseText,
    intentId: intent.id,
    confidence: classification.confidence,
    escalatedToBroker: shouldEscalate,
  };
}
