import type { WhatsAppSendResult, WhatsAppSender } from "./sender.js";
import type { TelefonoCanonicoStore } from "../../agent/telefonoCanonicoStore.js";

/**
 * Aplica y aprende el número canónico de Meta.
 *
 * Antes de enviar, si Meta ya nos dijo cuál es el `wa_id` de este destino, se
 * usa ese en vez del que veníamos usando. Después de enviar, si la respuesta
 * trae un `wa_id` distinto al que mandamos, se persiste.
 *
 * Va como decorador del sender —el mismo patrón que `SilentModeSender`—
 * porque los envíos salen del webhook, de los tres jobs del scheduler y de
 * `broker_accion_directa`: un `if` por llamador deja afuera al que se escriba
 * después.
 *
 * El efecto es que la normalización deja de depender de que acertemos las
 * reglas de cada país: la librería da el primer intento, y Meta corrige.
 */
export class CanonicalizingSender implements WhatsAppSender {
  constructor(
    private readonly interno: WhatsAppSender,
    private readonly store: TelefonoCanonicoStore
  ) {}

  async sendText(to: string, body: string): Promise<WhatsAppSendResult> {
    return this.conCanonico(to, (destino) => this.interno.sendText(destino, body));
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<WhatsAppSendResult> {
    return this.conCanonico(to, (destino) => this.interno.sendImage(destino, imageUrl, caption));
  }

  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    bodyParams: string[]
  ): Promise<WhatsAppSendResult> {
    return this.conCanonico(to, (destino) =>
      this.interno.sendTemplate(destino, templateName, languageCode, bodyParams)
    );
  }

  private async conCanonico(
    to: string,
    enviar: (destino: string) => Promise<WhatsAppSendResult>
  ): Promise<WhatsAppSendResult> {
    // Un fallo del store no puede impedir un envío: es una optimización de
    // exactitud, no un requisito. Si falla, se manda con lo que teníamos.
    let destino = to;
    try {
      destino = (await this.store.get(to)) ?? to;
    } catch (error) {
      console.warn("[canonico] no se pudo leer el canónico, se envía con el número original:", error);
    }

    const resultado = await enviar(destino);

    // Se aprende sólo cuando Meta dice algo distinto de lo que mandamos.
    if (resultado.waId && resultado.waId !== destino) {
      try {
        // Se registra bajo AMBAS claves: la original y la que se usó. Así el
        // próximo envío acierta venga por donde venga el número.
        await this.store.registrar(to, resultado.waId);
        if (destino !== to) await this.store.registrar(destino, resultado.waId);
        console.log(`[canonico] Meta corrigió el destino: •••${to.slice(-4)} -> •••${resultado.waId.slice(-4)}`);
      } catch (error) {
        console.warn("[canonico] no se pudo persistir el canónico:", error);
      }
    }

    return resultado;
  }
}
