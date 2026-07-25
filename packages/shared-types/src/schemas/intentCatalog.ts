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
});
export type IntentCatalogMeta = z.infer<typeof IntentCatalogMetaSchema>;

export const IntentCatalogSchema = z.object({
  version: z.number(),
  meta: IntentCatalogMetaSchema,
  intents: z.array(IntentSchema),
});
export type IntentCatalog = z.infer<typeof IntentCatalogSchema>;
