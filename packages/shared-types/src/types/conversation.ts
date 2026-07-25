// Estado de una conversación de WhatsApp. Sostiene en qué paso de un flujo
// multi-turno está el cliente (ej. agendar_visita: propuesta de horario ->
// espera confirmación) y las flags de pausa manual (broker_pausar_agente).

import type { IntentChannel } from "../schemas/intentCatalog.js";

export type ConversationStep =
  | "idle"
  | "esperando_confirmacion_horario"
  | "esperando_confirmacion_reprogramacion"
  | "esperando_ok_broker";

export interface ConversationState {
  conversationId: string;
  channel: IntentChannel;
  phoneNumber: string;
  leadId?: string;
  currentIntentId?: string;
  step: ConversationStep;
  pausedByBroker: boolean;
  context: Record<string, unknown>;
  updatedAt: string; // ISO datetime
}
