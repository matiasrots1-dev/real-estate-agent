/**
 * Avisa al broker, con el texto crudo, cuando un mensaje no se pudo procesar
 * (docs/TASKS.md Bloque 34).
 *
 * **No pasa por Claude** (modo de fallo 1 del pre-mortem). Si el mensaje falló
 * porque la API de Anthropic está caída, un aviso con borrador —que lo redacta
 * Claude— moriría por la misma causa y el broker seguiría sin enterarse. Este
 * aviso es texto armado acá y sale directo por WhatsApp.
 *
 * Agrupamiento, decisión del dueño del repo (opción B, 2026-09-19): los
 * primeros 5 fallos de una caída salen sueltos, al momento; desde el sexto, un
 * resumen cada 15 minutos; y un aviso cuando se recupera. Así un fallo aislado
 * llega enseguida, y una caída larga no se convierte en cuarenta avisos que
 * terminan silenciados (modo de fallo 4).
 *
 * El estado vive en memoria: si el proceso se reinicia en medio de una caída,
 * el resumen pendiente se pierde. El registro de verdad es el audit log, donde
 * cada mensaje queda como `fallido`. Esto es la alarma, no el registro.
 */

export interface CanalAlBroker {
  enviar(texto: string): Promise<void>;
}

export interface FalloDeProcesamiento {
  telefono: string;
  texto: string;
}

/** Lo que el webhook necesita. Interfaz aparte para poder reemplazarla en los tests. */
export interface AvisadorDeFallos {
  registrarFallo(fallo: FalloDeProcesamiento): Promise<void>;
  registrarExito(): Promise<void>;
}

export interface AvisoDeFallosOptions {
  canal: CanalAlBroker;
  /** Cuántos fallos de una misma caída se avisan uno por uno. */
  sueltosMaximos?: number;
  /** Cada cuánto sale el resumen de los fallos agrupados. */
  intervaloResumenMs?: number;
  /** Programa `fn` para dentro de `ms` y devuelve cómo cancelarlo. Inyectable para los tests. */
  programar?: (fn: () => void, ms: number) => () => void;
}

export const SUELTOS_MAXIMOS = 5;
export const INTERVALO_RESUMEN_MS = 15 * 60 * 1000;

/** Tope de mensajes listados en un resumen: WhatsApp corta los textos a 4096 caracteres. */
const MAX_EN_RESUMEN = 20;

function programarConTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  // Un resumen pendiente no tiene que mantener vivo el proceso al apagarlo.
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class AvisoDeFallos implements AvisadorDeFallos {
  private fallosEnCaida = 0;
  private agrupados: FalloDeProcesamiento[] = [];
  private cancelarResumen: (() => void) | null = null;
  private readonly canal: CanalAlBroker;
  private readonly sueltosMaximos: number;
  private readonly intervaloResumenMs: number;
  private readonly programar: (fn: () => void, ms: number) => () => void;

  constructor(opciones: AvisoDeFallosOptions) {
    this.canal = opciones.canal;
    this.sueltosMaximos = opciones.sueltosMaximos ?? SUELTOS_MAXIMOS;
    this.intervaloResumenMs = opciones.intervaloResumenMs ?? INTERVALO_RESUMEN_MS;
    this.programar = opciones.programar ?? programarConTimer;
  }

  async registrarFallo(fallo: FalloDeProcesamiento): Promise<void> {
    this.fallosEnCaida += 1;
    if (this.fallosEnCaida <= this.sueltosMaximos) {
      const esElUltimoSuelto = this.fallosEnCaida === this.sueltosMaximos;
      await this.enviar(textoSuelto(fallo, esElUltimoSuelto ? this.minutos() : null));
      return;
    }
    this.agrupados.push(fallo);
    if (!this.cancelarResumen) {
      this.cancelarResumen = this.programar(() => {
        this.cancelarResumen = null;
        void this.enviarResumen();
      }, this.intervaloResumenMs);
    }
  }

  async registrarExito(): Promise<void> {
    if (this.fallosEnCaida === 0) return;
    // El estado se cierra ANTES de cualquier await. Los mensajes de distintas
    // conversaciones se procesan en paralelo, y un fallo que llegue mientras se
    // manda este aviso tiene que abrir una caída nueva, no quedar contado en una
    // que ya se cerró.
    const total = this.fallosEnCaida;
    const pendientes = this.agrupados;
    this.fallosEnCaida = 0;
    this.agrupados = [];
    this.cancelarResumen?.();
    this.cancelarResumen = null;

    if (pendientes.length > 0) await this.enviar(textoResumen(pendientes, this.minutos()));
    await this.enviar(textoRecuperado(total));
  }

  private async enviarResumen(): Promise<void> {
    if (this.agrupados.length === 0) return;
    const lote = this.agrupados;
    this.agrupados = [];
    await this.enviar(textoResumen(lote, this.minutos()));
  }

  private minutos(): number {
    return Math.round(this.intervaloResumenMs / 60_000);
  }

  /** Best-effort: un aviso que no sale se loguea, nunca tira. */
  private async enviar(texto: string): Promise<void> {
    try {
      await this.canal.enviar(texto);
    } catch (error) {
      console.error("[aviso de fallos] no se pudo avisar al broker:", error);
    }
  }
}

function recortar(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}

function textoSuelto(fallo: FalloDeProcesamiento, minutosSiSeAgrupa: number | null): string {
  const lineas = [
    "⚠️ No pude procesar un mensaje. Al cliente NO se le respondió nada.",
    `De: ${fallo.telefono}`,
    `Mensaje: "${recortar(fallo.texto, 500)}"`,
    "Contestale vos. Quedó registrado como fallido.",
  ];
  if (minutosSiSeAgrupa !== null) {
    lineas.push(
      "",
      `Si siguen fallando, desde el próximo te los mando juntos, en un resumen cada ${minutosSiSeAgrupa} minutos.`
    );
  }
  return lineas.join("\n");
}

function textoResumen(lote: FalloDeProcesamiento[], minutos: number): string {
  const cuantos = `${lote.length} ${lote.length === 1 ? "mensaje" : "mensajes"}`;
  const lineas = [
    `⚠️ Siguen fallando: ${cuantos} sin procesar en los últimos ${minutos} minutos. A ninguno se le respondió nada.`,
    "",
  ];
  for (const fallo of lote.slice(0, MAX_EN_RESUMEN)) {
    lineas.push(`• ${fallo.telefono}: "${recortar(fallo.texto, 160)}"`);
  }
  if (lote.length > MAX_EN_RESUMEN) lineas.push(`… y ${lote.length - MAX_EN_RESUMEN} más.`);
  lineas.push("", "Contestales vos. Quedaron registrados como fallidos.");
  return lineas.join("\n");
}

function textoRecuperado(total: number): string {
  const cuantos = `${total} ${total === 1 ? "mensaje" : "mensajes"}`;
  return [
    "✅ El bot volvió a procesar mensajes.",
    `Durante la caída fallaron ${cuantos}; quedaron registrados como fallidos.`,
  ].join("\n");
}
