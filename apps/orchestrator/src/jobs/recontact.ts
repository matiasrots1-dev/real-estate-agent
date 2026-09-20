import { randomUUID } from "node:crypto";
import type { IntentCatalog, Lead } from "shared-types";
import { findIntent } from "../agent/intentCatalog.js";
import type { AuditLogStore } from "../agent/auditLog.js";
import type { ResponseComposer } from "../agent/composer.js";
import type { BrokerNotifier } from "../agent/brokerNotifier.js";
import type { RecontactStateStore } from "../agent/recontactStateStore.js";
import type { UltimoContactoStore } from "../agent/ultimoContactoStore.js";
import type { TokkoQueries } from "../mcp/tokkoMcpClient.js";
import type { WhatsAppSender } from "../channels/whatsapp/sender.js";
import type { ScheduledJob } from "./scheduler.js";
import type { TopeDiarioStore } from "./topeDiarioStore.js";
import {
  CONFIG_POR_DEFECTO,
  planificarRecontacto,
  puedeCorrer,
  type Destinatario,
  type EstadoDeContacto,
  type EstadosDeContacto,
  type PlanDeRecontacto,
  type RecontactoConfig,
} from "./recontactoPolicy.js";
import { evaluateCondition, parseCondition, type ParsedCondition } from "./scheduleCondition.js";

export interface RecontactJobDeps {
  catalog: IntentCatalog;
  tokko: TokkoQueries;
  composer: ResponseComposer;
  sender: WhatsAppSender;
  recontactStateStore: RecontactStateStore;
  auditLog: AuditLogStore;
  /**
   * Para anotar que el sistema contactó a ese lead (docs/TASKS.md Bloque 38f).
   * Sin esto, la regla de los 60 días entre mensajes sólo ve los contactos del
   * broker a mano y el propio job no se cuenta a sí mismo.
   */
  ultimoContactoStore: UltimoContactoStore;
  /** El tope por día, persistido: un contador en memoria no sobrevive a un reinicio. */
  topeDiarioStore: TopeDiarioStore;
  /**
   * Números a los que el job nunca le escribe (la línea del bot, el broker,
   * los usuarios de Tokko). **Obligatorio**: la política lo acepta opcional,
   * y si un llamador lo omitiera esa comprobación simplemente no pasaría, en
   * silencio. Quien no tenga la lista pasa `{ contiene: () => false }` y que
   * se vea (revisión del PR #48).
   */
  internos: { contiene(telefono: string): boolean };
  config?: RecontactoConfig;
  /**
   * `false` (default en config) = **simulacro**: calcula exactamente el mismo
   * plan, lo reporta y no manda ni escribe nada. Mismo criterio que el purgado
   * por retención del Bloque 15: lo irreversible no se hace sin un OK
   * explícito, y acá lo irreversible es un WhatsApp a alguien que no escribió.
   */
  envioHabilitado: boolean;
  /** Si no está configurado, el 3er intento (revisión del broker) se salta y solo se audita. */
  brokerNotifier?: BrokerNotifier;
  now?: () => Date;
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

interface Regla {
  raw: string;
  parsed: ParsedCondition;
}

/**
 * El intento vigente más alto que aplica a este lead y todavía no se mandó.
 * Es el catálogo el que decide **qué** mensaje toca (`schedule_rules`); la
 * política decide **a quién** se le manda y **cuántos** salen.
 */
function intentoPendiente(lead: Lead, rules: Regla[], attemptsSent: string[]): Regla | undefined {
  return [...rules]
    .sort((a, b) => b.parsed.value - a.parsed.value)
    .find((rule) => evaluateCondition(rule.parsed, lead.diasSinRespuesta) && !attemptsSent.includes(rule.raw));
}

/**
 * Manda (o escala) el recontacto de un lead ya seleccionado por la política.
 *
 * Devuelve `true` si **salió un mensaje al cliente**. El intento más alto no
 * devuelve `true`: va a revisión del broker y al lead no le llega nada, así
 * que no consume el tope diario, que cuenta mensajes a clientes.
 */
async function enviarRecontacto(
  lead: Lead,
  dueRule: Regla,
  maxThreshold: number,
  templateName: string,
  languageCode: string,
  intent: NonNullable<ReturnType<typeof findIntent>>,
  ahora: Date,
  deps: RecontactJobDeps
): Promise<boolean> {
  const state = (await deps.recontactStateStore.get(lead.id)) ?? { leadId: lead.id, attemptsSent: [] };
  const groundingData = await buildRecontactGrounding(lead, deps.tokko);
  const mensaje = await deps.composer.compose({
    intentDescription: intent.description,
    groundingData,
    language: deps.catalog.meta.language,
  });

  const isLastAttempt = dueRule.parsed.value === maxThreshold;
  let escalatedToBroker = false;
  let salio = false;

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
    salio = true;
    // El propio job tiene que contarse como contacto: si no, la regla de los
    // 60 días entre mensajes sólo ve lo que el broker escribió a mano y le
    // vuelve a escribir a la misma persona (docs/TASKS.md Bloques 27 y 38f).
    try {
      await deps.ultimoContactoStore.registrar(lead.telefonoWhatsapp, ahora, "sistema");
    } catch (error) {
      console.error(`jobs/recontact: no se pudo registrar el contacto del lead ${lead.id}:`, error);
    }
  }

  state.attemptsSent.push(dueRule.raw);
  await deps.recontactStateStore.save(state);

  await deps.auditLog.append({
    id: randomUUID(),
    conversationId: lead.telefonoWhatsapp,
    timestamp: ahora.toISOString(),
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

  return salio;
}

/**
 * El estado que mira la política: cuándo se contactó por última vez a cada
 * persona y cuántas veces le escribió el sistema.
 *
 * Las dos claves importan. Por `leadId` es lo natural; **por teléfono** es lo
 * que ataja las fichas duplicadas de Tokko: sin eso, dos fichas de la misma
 * persona son dos mensajes a la misma persona.
 */
async function leerEstados(
  candidatos: Lead[],
  /**
   * La regla del intento más alto, que NO le manda nada al cliente: va a
   * revisión del broker. No cuenta como "veces que se le escribió", porque a
   * esa persona no se le escribió (docs/TASKS.md Bloque 27).
   */
  reglaDeRevision: string,
  deps: RecontactJobDeps
): Promise<EstadosDeContacto> {
  const porLead = new Map<string, EstadoDeContacto>();
  const porTelefono = new Map<string, EstadoDeContacto>();

  const contactos = await deps.ultimoContactoStore.all();
  const contactadoAtPorClave = new Map(contactos.map((c) => [c.leadId, c.contactadoAt]));

  for (const lead of candidatos) {
    const state = await deps.recontactStateStore.get(lead.id);
    const estado: EstadoDeContacto = {
      intentos: (state?.attemptsSent ?? []).filter((r) => r !== reglaDeRevision).length,
      // El store se indexa por teléfono (así lo escribe el eco de
      // coexistencia), y el recontacto también anota por teléfono.
      ultimoContactoAt: contactadoAtPorClave.get(lead.telefonoWhatsapp) ?? contactadoAtPorClave.get(lead.id),
    };
    porLead.set(lead.id, estado);

    // La vista por teléfono se queda con lo MÁS restrictivo de las fichas que
    // lo comparten: más intentos y contacto más reciente.
    const previo = porTelefono.get(lead.telefonoWhatsapp);
    porTelefono.set(lead.telefonoWhatsapp, {
      intentos: Math.max(previo?.intentos ?? 0, estado.intentos),
      ultimoContactoAt: [previo?.ultimoContactoAt, estado.ultimoContactoAt].filter(Boolean).sort().at(-1),
    });
  }

  return { porLead, porTelefono };
}

/**
 * Lo que sale al log del servidor: **sin nombres ni teléfonos**. La lista
 * nominal es el reporte que el dueño del repo mira antes de aprobar
 * (`npm run recontacto:simulacro`), no algo que tenga que quedar duplicado en
 * el journal.
 */
function resumen(plan: PlanDeRecontacto, simulacro: boolean): string {
  const motivos = new Map<string, number>();
  for (const s of plan.suprimidos) motivos.set(s.motivo, (motivos.get(s.motivo) ?? 0) + 1);
  const detalle = [...motivos].map(([m, n]) => `${m}: ${n}`).join(", ");
  return (
    `jobs/recontact [${simulacro ? "SIMULACRO (no se mandó nada)" : "ENVÍO REAL"}]: ` +
    `evaluados ${plan.evaluados}, a enviar ${plan.aEnviar.length}, suprimidos ${plan.suprimidos.length}` +
    (detalle ? ` (${detalle})` : "") +
    (plan.duplicados.length > 0 ? ` | fichas duplicadas en Tokko: ${plan.duplicados.length}` : "") +
    (plan.topeAlcanzado ? " | TOPE ALCANZADO: quedó gente elegible sin contactar" : "")
  );
}

/**
 * docs/intent_catalog.yaml: recontacto_lead_frio. **El único job que le
 * escribe a gente que no escribió primero**, así que todo lo que decide a
 * quién y cuántos vive en `recontactoPolicy.ts` — el mismo módulo que corre
 * `npm run recontacto:simulacro`, que es lo que el dueño del repo mira para
 * aprobar. Si el job decidiera por su cuenta, el simulacro dejaría de
 * mostrar lo que va a pasar justo cuando más importa (docs/TASKS.md Bloque 27).
 *
 * El catálogo decide **qué** mensaje toca (`schedule_rules`, nunca
 * hardcodeadas — CLAUDE.md secc. 7); la política, **a quién** y **cuántos**.
 */
export function createRecontactJob(deps: RecontactJobDeps): ScheduledJob {
  const config = deps.config ?? CONFIG_POR_DEFECTO;

  return {
    name: "recontacto_lead_frio",
    async run(): Promise<void> {
      const ahora = (deps.now ?? (() => new Date()))();
      const intent = findIntent(deps.catalog, "recontacto_lead_frio");
      const rules: Regla[] = (intent?.schedule_rules ?? [])
        .filter((rule): rule is { condition: string } => Boolean(rule.condition))
        .map((rule) => ({ raw: rule.condition, parsed: parseCondition(rule.condition) }));

      if (!intent || rules.length === 0 || !intent.response.whatsapp_template_name) {
        console.error(
          'jobs/recontact: el intent "recontacto_lead_frio" no tiene schedule_rules de tipo condition o whatsapp_template_name en el catálogo.'
        );
        return;
      }

      // ¿Es momento? Se pregunta antes de leer a nadie: fuera de la ventana
      // horaria no hay nada que calcular.
      const ventana = puedeCorrer(ahora, await deps.topeDiarioStore.ultimaCorridaAt(), config);
      if (!ventana.puede) {
        console.log(`jobs/recontact: no corre ahora — ${ventana.motivo} (${ventana.detalle}).`);
        return;
      }

      const templateName = intent.response.whatsapp_template_name;
      const languageCode = toWhatsAppLanguageCode(deps.catalog.meta.language);
      const sortedByValue = [...rules].sort((a, b) => a.parsed.value - b.parsed.value);
      const minThreshold = sortedByValue[0].parsed.value;
      const maxThreshold = sortedByValue[sortedByValue.length - 1].parsed.value;

      // `paraRecontacto` filtra por el criterio del dueño del repo sobre el
      // contacto crudo de Tokko. Sin él, esto barre los ~3600 contactables de
      // toda la cuenta en vez de los que el simulacro muestra.
      const leads = await deps.tokko.searchLeads({ paraRecontacto: true, diasSinRespuestaMin: minThreshold });

      // Sólo entran al plan los que tienen un intento pendiente según el
      // catálogo: si entraran todos, un lead sin intento pendiente ocuparía un
      // lugar del tope y ese lugar se perdería sin mandar nada.
      const reglaDeRevision = sortedByValue[sortedByValue.length - 1].raw;
      const pendientes = new Map<string, Regla>();
      const candidatos: Lead[] = [];
      /**
       * El intento más alto no le manda nada al cliente: va a revisión del
       * broker. Va por su propio camino porque las reglas de la política
       * —los 60 días entre mensajes, el máximo de mensajes por persona, los
       * números internos— hablan de mensajes al cliente, y acá no hay
       * ninguno. Lo único que sí comparte es un tope, para que una cuenta con
       * miles de leads fríos no le vuelque cientos de avisos al broker de una.
       */
      const aRevision: Array<{ lead: Lead; due: Regla }> = [];
      for (const lead of leads) {
        const state = await deps.recontactStateStore.get(lead.id);
        const due = intentoPendiente(lead, rules, state?.attemptsSent ?? []);
        if (!due) continue;
        if (due.raw === reglaDeRevision) {
          if (aRevision.length < config.topePorCorrida) aRevision.push({ lead, due });
          continue;
        }
        pendientes.set(lead.id, due);
        candidatos.push(lead);
      }

      const estados = await leerEstados(candidatos, reglaDeRevision, deps);
      const enviadosHoy = await deps.topeDiarioStore.enviadosEn(ahora);
      const plan = planificarRecontacto(candidatos, estados, enviadosHoy, ahora, config, deps.internos);

      if (!deps.envioHabilitado) {
        if (aRevision.length > 0) {
          console.log(`jobs/recontact: ${aRevision.length} lead(s) pedirían tu revisión (no se avisó: simulacro).`);
        }
        // Simulacro: **no se toca ningún store**. Si se tocaran, el job no
        // mandaría nada pero dejaría a esa gente marcada como contactada, y al
        // habilitar el envío real no se la contactaría nunca — el mismo error
        // que el modo silencioso evita no registrando los jobs.
        console.log(resumen(plan, true));
        return;
      }

      // Primero los avisos al broker: no le escriben a nadie, así que no
      // dependen del plan ni de su tope.
      for (const { lead, due } of aRevision) {
        try {
          await enviarRecontacto(lead, due, maxThreshold, templateName, languageCode, intent, ahora, deps);
        } catch (error) {
          console.error(`jobs/recontact: no se pudo avisar al broker sobre el lead ${lead.id}:`, error);
        }
      }
      // Los avisos no suman al tope diario —no son mensajes a clientes— pero
      // sí cuentan para el intervalo entre corridas: si no, salen tres cada
      // cinco minutos.
      if (aRevision.length > 0) await deps.topeDiarioStore.registrarActividad(ahora);

      let enviados = 0;
      for (const destinatario of plan.aEnviar) {
        const lead = candidatos.find((l) => l.id === destinatario.leadId);
        const due = pendientes.get(destinatario.leadId);
        if (!lead || !due) continue;
        try {
          // Todo lo que llega acá es un mensaje al cliente: el intento que va
          // a revisión del broker se separó antes, en `aRevision`.
          await enviarRecontacto(lead, due, maxThreshold, templateName, languageCode, intent, ahora, deps);
          // Se suma DESPUÉS de que salió: sumar antes haría que un envío
          // fallido consumiera cupo, y no sumar haría que el tope no sea un
          // tope. `enviarRecontacto` tira si el envío falla, así que esta
          // línea no se alcanza en ese caso.
          enviados += 1;
          await deps.topeDiarioStore.sumar(ahora, 1);
        } catch (error) {
          console.error(`jobs/recontact: no se pudo procesar el lead ${destinatario.leadId}:`, error);
        }
      }

      console.log(resumen(plan, false) + (enviados !== plan.aEnviar.length ? ` | enviados: ${enviados}` : ""));
    },
  };
}

export type { Destinatario };
