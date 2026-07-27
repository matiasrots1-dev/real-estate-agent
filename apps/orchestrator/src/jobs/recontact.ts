import { randomUUID } from "node:crypto";
import type { IntentCatalog, Lead } from "shared-types";
import { findIntent } from "../agent/intentCatalog.js";
import type { AuditLogStore } from "../agent/auditLog.js";
import type { ResponseComposer } from "../agent/composer.js";
import type { BrokerNotifier } from "../agent/brokerNotifier.js";
import type { RecontactStateStore } from "../agent/recontactStateStore.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { ScheduledJob } from "./scheduler.js";
import { evaluateCondition, parseCondition, type ParsedCondition } from "./scheduleCondition.js";

export interface RecontactJobDeps {
  catalog: IntentCatalog;
  tokko: TokkoQueries;
  composer: ResponseComposer;
  sender: WhatsAppSender;
  recontactStateStore: RecontactStateStore;
  auditLog: AuditLogStore;
  /** Si no está configurado, el 3er intento (revisión del broker) se salta y solo se audita. */
  brokerNotifier?: BrokerNotifier;
}

function toWhatsAppLanguageCode(catalogLanguage: string): string {
  return catalogLanguage.replace("-", "_");
}

/**
 * Arma el grounding para el mensaje de recontacto: si la propiedad
 * original todavía está disponible, la menciona; si no, busca una
 * alternativa del mismo tipo (docs/intent_catalog.yaml: "para ofrecer
 * alternativas similares si la original ya no está"). Nunca inventa una
 * propiedad si Tokko no devolvió nada razonable.
 */
async function buildRecontactGrounding(lead: Lead, tokko: TokkoQueries): Promise<Record<string, unknown>> {
  const originalPropertyId = lead.propiedadesDeInteres[0];
  if (!originalPropertyId) return { propiedad_original: null, alternativa: null };

  const original = await tokko.getProperty(originalPropertyId);
  if (original?.estado === "disponible") {
    return { propiedad_original: original.direccionCorta, alternativa: null };
  }

  const alternativas = await tokko.searchProperties(original ? { tipo: original.tipo } : {});
  const alternativa = alternativas.find((p) => p.id !== originalPropertyId && p.estado === "disponible");

  return {
    propiedad_original: original?.direccionCorta ?? null,
    alternativa: alternativa?.direccionCorta ?? null,
  };
}

async function processLead(
  lead: Lead,
  rules: Array<{ raw: string; parsed: ParsedCondition }>,
  maxThreshold: number,
  templateName: string,
  languageCode: string,
  intent: NonNullable<ReturnType<typeof findIntent>>,
  deps: RecontactJobDeps
): Promise<void> {
  const state = (await deps.recontactStateStore.get(lead.id)) ?? { leadId: lead.id, attemptsSent: [] };

  // El intento vigente más alto que aplica y todavía no se mandó (de mayor a menor).
  const dueRule = [...rules]
    .sort((a, b) => b.parsed.value - a.parsed.value)
    .find((rule) => evaluateCondition(rule.parsed, lead.diasSinRespuesta) && !state.attemptsSent.includes(rule.raw));

  if (!dueRule) return;

  const groundingData = await buildRecontactGrounding(lead, deps.tokko);
  const mensaje = await deps.composer.compose({
    intentDescription: intent.description,
    groundingData,
    language: deps.catalog.meta.language,
  });

  const isLastAttempt = dueRule.parsed.value === maxThreshold;
  let escalatedToBroker = false;

  if (isLastAttempt) {
    // requires_broker: "conditional" — el intento más alto va a revisión
    // del broker antes de mandarse (docs/intent_catalog.yaml
    // escalation_reason), no se manda solo.
    escalatedToBroker = true;
    if (deps.brokerNotifier) {
      try {
        await deps.brokerNotifier.notify({
          conversationId: lead.telefonoWhatsapp,
          incomingMessage: `[recontacto automático — lead frío hace ${lead.diasSinRespuesta} días, sin mensaje entrante real]`,
          matchedIntentId: "recontacto_lead_frio",
          confidence: null,
          escalationReason: intent.escalation_reason,
          draftReply: mensaje,
        });
      } catch (error) {
        console.error(`jobs/recontact: no se pudo notificar al broker sobre el lead ${lead.id}:`, error);
      }
    }
    // TODO(Bloque 8+): si el broker aprueba o edita este borrador, hoy no
    // hay forma de que esa respuesta dispare el envío real — requiere
    // manejo del canal broker (docs/TASKS.md Bloque 8-10). Por ahora esto
    // es solo la notificación, el mensaje no sale al lead automáticamente.
  } else {
    await deps.sender.sendTemplate(lead.telefonoWhatsapp, templateName, languageCode, [lead.nombre, mensaje]);
  }

  state.attemptsSent.push(dueRule.raw);
  await deps.recontactStateStore.save(state);

  await deps.auditLog.append({
    id: randomUUID(),
    conversationId: lead.telefonoWhatsapp,
    timestamp: new Date().toISOString(),
    incomingMessage: `[recontacto automático "${dueRule.raw}" — sin mensaje entrante]`,
    matchedIntentId: "recontacto_lead_frio",
    confidence: null,
    toolsCalled: ["tokko.get_lead", "tokko.search_properties", isLastAttempt ? "" : "whatsapp.send_template"].filter(
      Boolean
    ),
    escalatedToBroker,
    escalationRule: escalatedToBroker ? "requires_broker" : undefined,
    escalationReason: escalatedToBroker ? intent.escalation_reason : undefined,
    responseSent: mensaje,
  });
}

/**
 * docs/intent_catalog.yaml: recontacto_lead_frio. Recorre leads fríos
 * (`tokko.search_leads`) y evalúa las `condition` del catálogo
 * ("dias_sin_respuesta >= 5/15/30") — nunca hardcodeadas (CLAUDE.md secc.
 * 7). El umbral más alto definido en el catálogo es el "3er intento": va a
 * revisión del broker antes de mandarse, no se manda solo.
 */
export function createRecontactJob(deps: RecontactJobDeps): ScheduledJob {
  return {
    name: "recontacto_lead_frio",
    async run(): Promise<void> {
      const intent = findIntent(deps.catalog, "recontacto_lead_frio");
      const rules = (intent?.schedule_rules ?? [])
        .filter((rule): rule is { condition: string } => Boolean(rule.condition))
        .map((rule) => ({ raw: rule.condition, parsed: parseCondition(rule.condition) }));

      if (!intent || rules.length === 0 || !intent.response.whatsapp_template_name) {
        console.error(
          'jobs/recontact: el intent "recontacto_lead_frio" no tiene schedule_rules de tipo condition o whatsapp_template_name en el catálogo.'
        );
        return;
      }

      const templateName = intent.response.whatsapp_template_name;
      const languageCode = toWhatsAppLanguageCode(deps.catalog.meta.language);
      const sortedByValue = [...rules].sort((a, b) => a.parsed.value - b.parsed.value);
      const minThreshold = sortedByValue[0].parsed.value;
      const maxThreshold = sortedByValue[sortedByValue.length - 1].parsed.value;

      const leads = await deps.tokko.searchLeads({ diasSinRespuestaMin: minThreshold });

      for (const lead of leads) {
        try {
          await processLead(lead, rules, maxThreshold, templateName, languageCode, intent, deps);
        } catch (error) {
          console.error(`jobs/recontact: no se pudo procesar el lead ${lead.id}:`, error);
        }
      }
    },
  };
}
