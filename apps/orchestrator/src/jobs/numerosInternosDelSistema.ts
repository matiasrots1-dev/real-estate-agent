import { NumerosInternos } from "./numerosInternos.js";

/**
 * Junta los números a los que el recontacto **nunca** le puede escribir
 * (docs/TASKS.md Bloque 27).
 *
 * Son varias fuentes porque ninguna alcanza sola: el `.env` puede tener un
 * número viejo (de hecho lo tenía), y la línea de WhatsApp Business no está
 * en el `.env` — hay que preguntársela a Meta, que es la autoridad sobre cuál
 * es. Esa línea está además cargada como un contacto más en el CRM y **pasa
 * el criterio de recontacto**: escribirle es escribirle a la misma línea que
 * recibe a los clientes, y como ese número le manda mensajes al sistema puede
 * armar un lazo.
 *
 * Devuelve qué fuentes faltaron en vez de tragárselo: el llamador decide, y la
 * decisión del servidor es no enviar nada si falta alguna. Fallar cerrado es
 * barato —no se le escribe a nadie ese día— y el error contrario no se
 * deshace.
 */
export interface FuentesDeNumerosInternos {
  /** El número personal del broker, del `.env`. */
  brokerWhatsappNumber?: string;
  /** La línea del bot, preguntándosela a Meta. */
  lineaDelBot?: () => Promise<string | undefined>;
  /** Los teléfonos de los usuarios de la cuenta de Tokko. */
  usuariosDeTokko?: () => Promise<string[]>;
}

/**
 * ¿Se puede enviar de verdad? Sólo si alguien lo habilitó **y** están todos
 * los números que nunca deben recibir (docs/TASKS.md Bloque 27).
 *
 * Falla cerrado a propósito: no escribirle a nadie hoy es recuperable y se ve
 * en el log; escribirle a la propia línea del bot —que está cargada en el CRM
 * y pasa el criterio de recontacto— no se deshace, y encima puede armar un
 * lazo, porque ese número le manda mensajes al sistema.
 */
export function envioDeRecontactoPermitido(args: {
  habilitadoPorConfig: boolean;
  faltantes: readonly string[];
}): { permitido: boolean; motivo?: string } {
  if (!args.habilitadoPorConfig) return { permitido: false };
  if (args.faltantes.length > 0) {
    return {
      permitido: false,
      motivo:
        `el envío real está habilitado por config pero queda en SIMULACRO — ` +
        `faltan números internos que nunca deben recibir: ${args.faltantes.join("; ")}`,
    };
  }
  return { permitido: true };
}

export interface NumerosInternosReunidos {
  internos: NumerosInternos;
  /** Fuentes que no se pudieron leer o que no estaban configuradas. */
  faltantes: string[];
}

export async function reunirNumerosInternos(
  fuentes: FuentesDeNumerosInternos
): Promise<NumerosInternosReunidos> {
  const internos = new NumerosInternos();
  const faltantes: string[] = [];

  if (fuentes.brokerWhatsappNumber) internos.agregar(fuentes.brokerWhatsappNumber);
  else faltantes.push("el número del broker (BROKER_WHATSAPP_NUMBER)");

  if (fuentes.lineaDelBot) {
    try {
      const linea = await fuentes.lineaDelBot();
      if (linea) internos.agregar(linea);
      else faltantes.push("la línea del bot (Meta no devolvió el número)");
    } catch (error) {
      console.error("[internos] no se pudo consultar la línea del bot a Meta:", error);
      faltantes.push("la línea del bot (falló la consulta a Meta)");
    }
  } else {
    faltantes.push("la línea del bot (sin credenciales de WhatsApp)");
  }

  if (fuentes.usuariosDeTokko) {
    try {
      const telefonos = await fuentes.usuariosDeTokko();
      internos.agregar(...telefonos);
    } catch (error) {
      console.error("[internos] no se pudieron leer los usuarios de Tokko:", error);
      faltantes.push("los teléfonos de los usuarios de Tokko");
    }
  } else {
    faltantes.push("los teléfonos de los usuarios de Tokko");
  }

  return { internos, faltantes };
}
