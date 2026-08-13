/**
 * Contador de qué pasó con cada POST a `/webhook`.
 *
 * Existe por el incidente del 2026-08-12: el proveedor midió **39 POST** en la
 * ventana y el `audit_log` sólo tenía **6**. Los otros 33 salieron por alguna
 * de las salidas tempranas de `app.ts` y ninguna dejaba rastro, así que la
 * pregunta "¿qué pasó con los otros 33?" no tenía respuesta desde adentro del
 * sistema (docs/TASKS.md Bloque 22).
 *
 * El `audit_log` no sirve para esto y no hay que forzarlo: audita **mensajes
 * clasificados**, que es su trabajo. Un webhook de status de Meta no es un
 * mensaje y no tiene por qué ensuciar la auditoría de conversaciones — ni
 * quedar sujeto a su política de retención.
 */

/** Cada salida posible del camino POST /webhook. Suman el total de POSTs. */
export type WebhookOutcome =
  /** Se encoló para procesar: es el único que termina en el audit_log. */
  | "procesado"
  | "rechazado_firma_invalida"
  | "rechazado_firma_ausente"
  | "rechazado_sin_secreto"
  | "rechazado_secreto_proveedor"
  | "json_invalido"
  /** Payload válido pero sin mensaje de texto: statuses, tipos no soportados. */
  | "sin_mensaje"
  /** Reintento de Meta con un id ya visto. */
  | "duplicado"
  /** Espejo de coexistencia: un mensaje que el broker mando desde su celular. */
  | "eco_descartado";

export interface WebhookTally {
  /** Desde cuándo se cuenta. Sin esto, un reinicio hace leer mal la ventana. */
  desde: string;
  total: number;
  porResultado: Record<string, number>;
  /** Desglose de los `sin_mensaje`: statuses, imagen, audio, etc. */
  sinMensajePorTipo: Record<string, number>;
}

export interface WebhookMetrics {
  registrar(outcome: WebhookOutcome, detalle?: string): void;
  resumen(): WebhookTally;
}

export class InMemoryWebhookMetrics implements WebhookMetrics {
  private readonly porResultado = new Map<string, number>();
  private readonly sinMensajePorTipo = new Map<string, number>();
  private total = 0;

  constructor(private readonly desde: Date = new Date()) {}

  registrar(outcome: WebhookOutcome, detalle?: string): void {
    this.total += 1;
    this.porResultado.set(outcome, (this.porResultado.get(outcome) ?? 0) + 1);
    if (outcome === "sin_mensaje" && detalle) {
      this.sinMensajePorTipo.set(detalle, (this.sinMensajePorTipo.get(detalle) ?? 0) + 1);
    }
  }

  resumen(): WebhookTally {
    return {
      desde: this.desde.toISOString(),
      total: this.total,
      porResultado: Object.fromEntries(this.porResultado),
      sinMensajePorTipo: Object.fromEntries(this.sinMensajePorTipo),
    };
  }
}
