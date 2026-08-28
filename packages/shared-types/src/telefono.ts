import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/**
 * Normalización de teléfonos para WhatsApp.
 *
 * Por qué una librería y no reglas propias: Argentina es de los peores casos
 * del mundo para esto. Un mismo celular se escribe `011 15 5555-1234`,
 * `15-5555-1234`, `+54 9 11 5555 1234` o `91155551234`, y **el `9` es
 * obligatorio para WhatsApp** aunque los humanos casi nunca lo escriban.
 * Verificado contra la librería:
 *
 *   `011 15 5555 1234` -> +5491155551234  MOBILE      ✅
 *   `91155551234`      -> +5491155551234  MOBILE      ✅
 *   `1155551234`       -> +541155551234   FIXED_LINE  ⚠️
 *
 * Ese último caso es la trampa: un celular cargado sin el `9` y sin el `15`
 * **parsea como fijo y `isValid()` devuelve `true`**. Pasa cualquier chequeo
 * de validez y no tiene WhatsApp. Por eso no alcanza con validar: hay que
 * exigir que el tipo sea móvil.
 *
 * Se usa la build `/max` a propósito — la default no incluye la metadata de
 * tipo y `getType()` devuelve `undefined` siempre.
 */

/** Región asumida cuando el número viene sin código de país. */
export const REGION_POR_DEFECTO = "AR" as const;

export type MotivoTelefonoNoUsable =
  /** Vacío o sin dígitos. */
  | "sin_telefono"
  /** No parsea como número de ningún país. */
  | "no_parseable"
  /** Parsea pero la librería lo da por inválido. */
  | "invalido"
  /** Válido, pero es una línea fija: no tiene WhatsApp. */
  | "no_es_movil";

export interface TelefonoNormalizado {
  /** Solo `true` si se puede mandar un WhatsApp a este número. */
  usable: boolean;
  /**
   * E.164 **sin el `+`** — `5491155551234`. Es lo que espera la Graph API y
   * lo que Meta usa como `wa_id`. Solo presente si `usable`.
   */
  paraEnviar?: string;
  /**
   * Formato nacional legible — `011 15-5555-1234`. **Nunca se usa para
   * enviar**: es un campo aparte a propósito, para que nadie confunda el
   * formato de lectura con el de envío.
   */
  paraMostrar?: string;
  /** Qué tipo detectó la librería (`MOBILE`, `FIXED_LINE`, …). */
  tipo?: string;
  /**
   * Número nacional (sin código de país), presente para **cualquier** número
   * válido, sea móvil o fijo. Sirve para *identificar* un número, no para
   * enviarle: es lo que permite reconocer que el fijo y el celular de una
   * misma persona son la misma persona.
   */
  nacional?: string;
  motivo?: MotivoTelefonoNoUsable;
  /** Lo que había cargado, tal cual, para poder ir a corregirlo al CRM. */
  original: string;
}

export function normalizarTelefono(
  crudo: string | null | undefined,
  region: string = REGION_POR_DEFECTO
): TelefonoNormalizado {
  const original = String(crudo ?? "");

  if (!original.trim() || !/\d/.test(original)) {
    return { usable: false, motivo: "sin_telefono", original };
  }

  let parsed;
  try {
    // La librería tolera espacios, guiones, paréntesis y el 0/15 doméstico,
    // así que no hay que pre-limpiar nada — limpiar a mano acá sería
    // reintroducir las reglas por país que justamente se quieren evitar.
    parsed = parsePhoneNumberFromString(original, region as never);
  } catch {
    return { usable: false, motivo: "no_parseable", original };
  }

  if (!parsed) return { usable: false, motivo: "no_parseable", original };
  if (!parsed.isValid()) return { usable: false, motivo: "invalido", original };

  const nacional = String(parsed.nationalNumber);
  const tipo = parsed.getType();
  if (tipo !== "MOBILE") {
    // FIXED_LINE, VOIP, FIXED_LINE_OR_MOBILE o desconocido: no se manda.
    // Cae del lado seguro igual que el estado indeterminado de una propiedad —
    // no mandar de más es recuperable, mandar a la nada no se detecta.
    return { usable: false, motivo: "no_es_movil", tipo: tipo ?? "desconocido", nacional, original };
  }

  return {
    usable: true,
    paraEnviar: parsed.format("E.164").replace(/^\+/, ""),
    paraMostrar: parsed.formatNational(),
    tipo,
    nacional,
    original,
  };
}
