import { z } from "zod";

// Espeja la estructura de docs/intent_catalog.yaml. Ese YAML es la fuente de
// verdad de las reglas de negocio (ver CLAUDE.md secc. 2) — este schema
// valida su forma, no la duplica; si el YAML gana un campo, el schema debe
// actualizarse para reflejarlo.

export const IntentChannelSchema = z.enum(["cliente", "broker", "any"]);
export type IntentChannel = z.infer<typeof IntentChannelSchema>;

export const IntentPrioritySchema = z.enum([
  "critical",
  "high",
  "normal",
  "low",
]);
export type IntentPriority = z.infer<typeof IntentPrioritySchema>;

export const ResponseStyleSchema = z.enum(["template", "generative_grounded"]);
export type ResponseStyle = z.infer<typeof ResponseStyleSchema>;

// true | false | "conditional" (ver docs/escalation_policy.md)
export const RequiresBrokerSchema = z.union([z.boolean(), z.literal("conditional")]);
export type RequiresBroker = z.infer<typeof RequiresBrokerSchema>;

export const IntentTriggersSchema = z.object({
  examples: z.array(z.string()),
});
export type IntentTriggers = z.infer<typeof IntentTriggersSchema>;

// Reglas de disparo para intents proactivos (trigger_type: scheduled).
// Cada regla es un offset relativo a un evento ("-24h") o una condición
// evaluada sobre el estado del lead ("dias_sin_respuesta >= 5").
export const ScheduleRuleSchema = z.object({
  offset: z.string().optional(),
  condition: z.string().optional(),
});
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

export const IntentResponseSchema = z.object({
  style: ResponseStyleSchema,
  template: z.string().optional(),
  grounding_fields: z.array(z.string()).optional(),
  fallback_if_not_found: z.string().optional(),
  fallback_if_missing_field: z.string().optional(),
  /**
   * La plantilla es una frase de espera ("te paso con el asesor"): sale una
   * sola vez por conversación mientras el broker no responda (docs/TASKS.md
   * Bloques 31 y 38e). Una despedida o una confirmación NO son frases de
   * espera, aunque también sean texto fijo.
   */
  espera: z.boolean().optional(),
  whatsapp_template_name: z.string().optional(),
  requires_preview_if_bulk: z.boolean().optional(),
});
export type IntentResponse = z.infer<typeof IntentResponseSchema>;

export const IntentSchema = z.object({
  id: z.string(),
  description: z.string(),
  channel: IntentChannelSchema,
  priority: IntentPrioritySchema,
  trigger_type: z.literal("scheduled").optional(),
  triggers: IntentTriggersSchema.optional(),
  schedule_rules: z.array(ScheduleRuleSchema).optional(),
  tools: z.array(z.string()),
  requires_client_confirmation: z.boolean(),
  requires_broker: RequiresBrokerSchema,
  escalation_reason: z.string().optional(),
  confidence_threshold: z.number().nullable(),
  response: IntentResponseSchema,
});
export type Intent = z.infer<typeof IntentSchema>;

export const IntentCatalogMetaSchema = z.object({
  default_confidence_threshold: z.number(),
  escalation_channel: z.string(),
  audit_log: z.boolean(),
  language: z.string(),
  /**
   * El intent cuya plantilla es la respuesta de espera genérica: la que recibe
   * el cliente cuando algo escala y el intent no tiene una plantilla de espera
   * propia (docs/TASKS.md Bloque 38c).
   */
  escalation_waiting_template_from: z.string(),
});
export type IntentCatalogMeta = z.infer<typeof IntentCatalogMetaSchema>;

/**
 * Un hueco sin llenar de una plantilla del catálogo: `{direccion_corta}`, y
 * también `{dirección}`, `{Nombre}` o `{direccion2}`, que el reemplazo de
 * plantillas acepta igual. No cuenta llaves con espacios adentro, como
 * `{USD 350.000}`: ningún hueco del catálogo los tiene.
 */
export const HUECO_DE_PLANTILLA = /\{[^{}\s]+\}/;

/**
 * Además de la forma, el catálogo tiene que cumplir dos cosas de las que
 * depende el escalamiento (docs/TASKS.md Bloque 38c). Si no, falla al
 * cargarlo, antes de mandarle algo roto a un cliente:
 *
 * - la plantilla de espera genérica existe y no tiene huecos;
 * - la plantilla de todo intent que escala siempre (`requires_broker: true`)
 *   es una plantilla de espera: sin huecos, porque se manda tal cual.
 */
export const IntentCatalogSchema = z
  .object({
    version: z.number(),
    meta: IntentCatalogMetaSchema,
    intents: z.array(IntentSchema),
  })
  .superRefine((catalogo, ctx) => {
    const idEspera = catalogo.meta.escalation_waiting_template_from;
    const espera = catalogo.intents.find((intent) => intent.id === idEspera);
    if (!espera) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "escalation_waiting_template_from"],
        message: `no existe ningún intent "${idEspera}"`,
      });
    } else if (!espera.response.template) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "escalation_waiting_template_from"],
        message: `el intent "${idEspera}" no tiene plantilla`,
      });
    }

    if (espera && espera.response.espera !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "escalation_waiting_template_from"],
        message: `el intent "${idEspera}" es la plantilla de espera genérica, así que su respuesta tiene que estar marcada "espera: true"`,
      });
    }

    catalogo.intents.forEach((intent, i) => {
      const plantilla = intent.response.template;
      const ruta = ["intents", i, "response"];
      const debeSerDeEspera = intent.requires_broker === true || intent.id === idEspera || intent.response.espera === true;
      if (debeSerDeEspera && plantilla && HUECO_DE_PLANTILLA.test(plantilla)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...ruta, "template"],
          message: `"${intent.id}" escala sin llenar datos, así que su plantilla no puede tener huecos: "${plantilla}"`,
        });
      }

      // Una frase de espera sin plantilla no existe: `frasesDeEspera` la
      // ignoraría en silencio y el intent quedaría fuera del cupo creyendo
      // que está adentro (revisión del PR #42).
      if (intent.response.espera === true && !plantilla) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...ruta, "espera"],
          message: `"${intent.id}" está marcado como frase de espera pero no tiene plantilla`,
        });
      }

      // La supresión está cableada en el camino de escalamiento: una frase de
      // espera en un intent que no escala saldría sin pasar por ahí, pero
      // gastaría igual el cupo de la conversación.
      if (intent.response.espera === true && intent.requires_broker !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...ruta, "espera"],
          message: `"${intent.id}" está marcado como frase de espera pero no escala siempre (requires_broker: true)`,
        });
      }

      // Y al revés: un intent que escala siempre con una plantilla fija TIENE
      // que decir si es una frase de espera. Sin esto, el que se agregue
      // mañana queda fuera del cupo por olvido y su frase se repite.
      const plantillaFija = plantilla !== undefined && !HUECO_DE_PLANTILLA.test(plantilla);
      if (intent.requires_broker === true && plantillaFija && intent.response.espera === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...ruta, "espera"],
          message:
            `"${intent.id}" escala siempre con una plantilla fija: tiene que decir si es una frase de espera ` +
            `("espera: true") o no ("espera: false", como una despedida)`,
        });
      }
    });
  });
export type IntentCatalog = z.infer<typeof IntentCatalogSchema>;
