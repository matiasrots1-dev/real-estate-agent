import type { WhatsAppSendResult, WhatsAppSender } from "./sender.js";

/**
 * Envoltorio que **bloquea todo envío que no vaya al broker**.
 *
 * Por qué acá y no con un `if` en el llamador: los mensajes a clientes salen
 * desde varios lugares — el webhook, los tres jobs del scheduler
 * (recordatorios, recontacto, seguimiento post-visita) y
 * `broker_accion_directa`. Un `if` por llamador deja afuera al que se escriba
 * mañana. El sender es el único punto por el que pasan todos, así que el
 * filtro va acá: lo que no lo atraviese, no sale.
 *
 * Existe por el incidente del 2026-08-12: al activarse el forward del
 * proveedor entraron mensajes de personas reales y el agente les respondió
 * solo (docs/TASKS.md Bloque 21).
 */
export class SilentModeSender implements WhatsAppSender {
  private bloqueados = 0;

  constructor(
    private readonly interno: WhatsAppSender,
    private readonly brokerWhatsappNumber: string | undefined,
    private readonly onBloqueado: (destino: string, tipo: string, total: number) => void = avisarPorDefecto
  ) {}

  async sendText(to: string, body: string): Promise<WhatsAppSendResult> {
    if (!this.esBroker(to)) return this.bloquear(to, "texto");
    return this.interno.sendText(to, body);
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<WhatsAppSendResult> {
    if (!this.esBroker(to)) return this.bloquear(to, "imagen");
    return this.interno.sendImage(to, imageUrl, caption);
  }

  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    bodyParams: string[]
  ): Promise<WhatsAppSendResult> {
    if (!this.esBroker(to)) return this.bloquear(to, `plantilla:${templateName}`);
    return this.interno.sendTemplate(to, templateName, languageCode, bodyParams);
  }

  bloqueadosHastaAhora(): number {
    return this.bloqueados;
  }

  /**
   * Sin número de broker configurado no hay ningún destino legítimo, así que
   * **no sale nada**. Falla cerrado a propósito: el error de dejar pasar un
   * mensaje a un desconocido no se deshace, el de no mandar ninguno sí.
   */
  private esBroker(to: string): boolean {
    if (!this.brokerWhatsappNumber) return false;
    return soloDigitos(to) === soloDigitos(this.brokerWhatsappNumber);
  }

  private bloquear(to: string, tipo: string): WhatsAppSendResult {
    this.bloqueados += 1;
    try {
      this.onBloqueado(to, tipo, this.bloqueados);
    } catch {
      /* el logueo no puede convertirse en un envío */
    }
    // Se devuelve un resultado vacío en vez de lanzar: los jobs y el webhook
    // tratan una excepción como fallo y podrían reintentar. Acá no falló nada,
    // simplemente no había que mandarlo.
    return { raw: { messaging_product: "whatsapp" } };
  }
}

function soloDigitos(numero: string): string {
  return numero.replace(/\D/g, "");
}

function avisarPorDefecto(destino: string, tipo: string, total: number): void {
  // El destino se enmascara: es el teléfono de una persona y este log puede
  // terminar en cualquier lado. Los últimos 4 alcanzan para reconocerlo.
  console.warn(
    `[silencioso] envío BLOQUEADO tipo=${tipo} destino=•••${destino.slice(-4)} (van ${total})`
  );
}
