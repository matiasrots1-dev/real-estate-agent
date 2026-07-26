import { randomUUID } from "node:crypto";
import type { AuditLogEntry, Intent, IntentCatalog } from "shared-types";
import type { IncomingWhatsAppMessage } from "../channels/whatsapp/webhookPayload.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import { effectiveConfidenceThreshold, findIntent } from "./intentCatalog.js";
import type { IntentClassifier } from "./classifier.js";
import type { ResponseComposer } from "./composer.js";
import type { DraftReplyComposer } from "./draftComposer.js";
import type { BrokerNotifier } from "./brokerNotifier.js";
import type { AuditLogStore } from "./auditLog.js";
import { decideEscalation } from "./escalation.js";
import { runConsultaDisponibilidad } from "./consultaDisponibilidad.js";

/**
 * El intent matcheó pero no hay handler para él todavía: ni escala (no es
 * `requires_broker: true` ni cae por baja confianza) ni es
 * `consulta_disponibilidad` (ver docs/TASKS.md Bloque 5 — resto de intents
 * reactivos, y Bloque 4/5 para los "conditional"). Se lanza en vez de
 * improvisar una respuesta o inventar datos — server.ts la atrapa y no
 * manda nada al cliente.
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
  draftComposer: DraftReplyComposer;
  tokko: TokkoQueries;
  auditLog: AuditLogStore;
  /** Si no está configurado (sin BROKER_WHATSAPP_NUMBER), se escala igual pero no se notifica a nadie. */
  brokerNotifier?: BrokerNotifier;
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
  const decision = decideEscalation(intent, classification.confidence, threshold);

  let responseText: string;
  const toolsCalled: string[] = [];

  if (decision.shouldEscalate) {
    // docs/escalation_policy.md: el agente nunca queda mudo — responde al
    // cliente con la plantilla de espera del intent, y por separado
    // notifica al broker con contexto + borrador. Un fallo notificando al
    // broker no debe impedir que el cliente reciba su respuesta.
    responseText =
      intent.response.template ?? "Dejame confirmarlo con el asesor y te respondo enseguida.";
    await notifyBrokerBestEffort(deps, message, intent, classification.confidence, decision.reason);
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
    escalatedToBroker: decision.shouldEscalate,
    escalationRule: decision.rule,
    escalationReason: decision.reason,
    responseSent: responseText,
  };
  await deps.auditLog.append(auditEntry);

  return {
    responseText,
    intentId: intent.id,
    confidence: classification.confidence,
    escalatedToBroker: decision.shouldEscalate,
  };
}

async function notifyBrokerBestEffort(
  deps: HandleMessageDeps,
  message: IncomingWhatsAppMessage,
  intent: Intent,
  confidence: number,
  escalationReason: string | undefined
): Promise<void> {
  if (!deps.brokerNotifier) return;
  try {
    const draftReply = await deps.draftComposer.composeDraft(message.text, intent.description);
    await deps.brokerNotifier.notify({
      conversationId: message.from,
      incomingMessage: message.text,
      matchedIntentId: intent.id,
      confidence,
      escalationReason,
      draftReply,
    });
  } catch (error) {
    console.error("No se pudo notificar al broker (el cliente igual recibe su respuesta):", error);
  }
}
